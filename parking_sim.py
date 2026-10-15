"""A beginner-friendly comparison of normal and smart parking.

Time is measured in minutes. Distances and prices are illustrative assumptions.
Run: python parking_sim.py
"""

import json
import random
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import simpy


# ====================== CONFIGURATION ======================
LEGACY_MODE = True                      # True reproduces the original model exactly.
SEED = 42
RUNS = 10
EXPORT_RUN = 0                          # Zero-based run index; does not change its seed.
EXPORT_FILE = "simulation_log.json"
NORMAL_SPOTS = 40
EV_SPOTS = 5
RESERVED_SPOTS = 5

START_HOUR = 7
SIMULATION_MINUTES = 12 * 60              # Observe 07:00 to 19:00.
BASE_ARRIVALS_PER_HOUR = 20
PEAK_ARRIVALS_PER_HOUR = 55
PEAK_PERIODS = [(8, 10), (16, 18)]        # End hours are exclusive.
EV_CAR_SHARE = 0.10
RESERVED_CAR_SHARE = 0.10                # Other cars are normal cars.

PARKING_MINUTES = (45, 150)              # Uniform random parking duration.
PATIENCE_MINUTES = (3, 8)                # Maximum entrance waiting time.
RECHECK_MINUTES = 0.5                   # Waiting cars retry every 30 seconds.
NORMAL_SEARCH_MINUTES = (3, 8)          # Extra time spent driving around.
SMART_GUIDANCE_MINUTES = 0.25           # Sensor/assignment overhead.
DISTANCE_BETWEEN_SPOTS_METERS = 5
DRIVING_SPEED_METERS_PER_MINUTE = 100

BASE_PRICE_PER_HOUR = 20.0              # Illustrative currency units (CU).
HIGH_OCCUPANCY_THRESHOLD = 0.80
HIGH_PRICE_MULTIPLIER = 1.50
SAMPLE_MINUTES = 5
CONSOLE_EVERY_MINUTES = 60
SHOW_CONSOLE = True                     # Show only run 1 of each mode.
SHOW_CHARTS = True                      # False saves charts without opening them.

# Part A settings: ALL are ignored when LEGACY_MODE is True.
MAX_PRICE_PER_HOUR = (20.0, 35.0)        # Uniform willingness to pay for parking.
NORMAL_EXTRA_SEARCH_MINUTES = 0.5       # Delay before another unreserved attempt.
EV_CHARGING_MINUTES = (20.0, 60.0)       # Requested charging duration, uniform.
EV_SESSION_FEE = 6.0                    # Flat fee, even for a partially charged visit.
EV_IDLE_FEE_PER_HOUR = 3.0              # After charging ends, until the bay is freed.
EV_ALLOW_NORMAL_FALLBACK = True
LEVELS = 2                             # Level 1 is the ground level.
RAMP_MINUTES_PER_LEVEL = 1.0
ENTRY_GATE_SERVICE_MINUTES = 0.10       # Six seconds; one car at a time.
EXIT_GATE_SERVICE_MINUTES = 0.08        # 4.8 seconds; a separate gate.
# ===========================================================

OUTPUT_DIR = Path(__file__).resolve().parent


def result_directory():
    """Keep the working legacy replay and results separate from Part A outputs."""
    directory = OUTPUT_DIR if LEGACY_MODE else OUTPUT_DIR / "part_a"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def arrival_rate(minute):
    """Return the arrival rate per hour at this time of day."""
    hour = START_HOUR + minute / 60
    for start, end in PEAK_PERIODS:
        if start <= hour < end:
            return PEAK_ARRIVALS_PER_HOUR
    return BASE_ARRIVALS_PER_HOUR


def make_cars(seed):
    """Prepare identical traffic for both modes using a local random generator.

    Thinning creates a Poisson arrival process with a changing rate: generate
    candidates at the maximum rate, then accept each with rate/max_rate.
    This correctly handles a candidate crossing a peak-period boundary.
    """
    rng = random.Random(seed)
    max_rate = max(BASE_ARRIVALS_PER_HOUR, PEAK_ARRIVALS_PER_HOUR)
    cars = []
    minute = 0.0
    if max_rate == 0:
        return cars

    while True:
        minute += rng.expovariate(max_rate / 60)
        if minute >= SIMULATION_MINUTES:
            break
        if rng.random() >= arrival_rate(minute) / max_rate:
            continue

        choice = rng.random()
        if choice < EV_CAR_SHARE:
            kind = "EV"
        elif choice < EV_CAR_SHARE + RESERVED_CAR_SHARE:
            kind = "Reserved"
        else:
            kind = "Normal"

        cars.append({
            "arrival": minute,
            "kind": kind,
            "parking": rng.uniform(*PARKING_MINUTES),
            "patience": rng.uniform(*PATIENCE_MINUTES),
            "normal_search": rng.uniform(*NORMAL_SEARCH_MINUTES),
            "spot_choice": rng.random(),
        })
    if not LEGACY_MODE:
        # Draw new attributes AFTER all original traffic has been generated.
        # Thus the same seed still gives identical arrivals, kinds and stays.
        for car in cars:
            car["max_price_per_hour"] = rng.uniform(*MAX_PRICE_PER_HOUR)
            car["charging_minutes"] = (rng.uniform(*EV_CHARGING_MINUTES)
                                       if car["kind"] == "EV" else 0.0)
    return cars


class ParkingLot:
    """Store the spots and the measurements for one simulation run."""

    def __init__(self, env, mode, show_console=False, event_log=None):
        self.env = env
        self.mode = mode
        self.show_console = show_console
        self.event_log = event_log      # None means this run is not being exported.
        self.spots = []
        for kind, count in [("Normal", NORMAL_SPOTS), ("EV", EV_SPOTS),
                            ("Reserved", RESERVED_SPOTS)]:
            for _ in range(count):
                self.spots.append({
                    "kind": kind,
                    "distance": (len(self.spots) + 1) * DISTANCE_BETWEEN_SPOTS_METERS,
                    "busy": False,
                })
        self.busy = 0
        self.last_change = 0.0
        self.occupied_spot_minutes = 0.0
        self.search_times = []
        self.turned_away = 0
        self.revenue = 0.0
        self.samples = []

    def free_spots(self, kind):
        """Normal cars use normal spots; other cars can also use their own type.

        EV charging energy is not modeled. Reserved cars represent permit holders.
        A car can be turned away even if an ineligible spot is free.
        """
        return [i for i, spot in enumerate(self.spots)
                if not spot["busy"] and spot["kind"] in ("Normal", kind)]

    def change_occupancy(self, change):
        """Integrate occupancy exactly, instead of averaging occasional snapshots."""
        now = min(self.env.now, SIMULATION_MINUTES)
        self.occupied_spot_minutes += self.busy * (now - self.last_change)
        self.last_change = now
        self.busy += change

    def handle_car(self, car):
        """Wait for a spot, search/drive to it, park, and finally leave."""
        # Logging only observes events: it adds no random draws or SimPy timeouts.
        entry = None
        if self.event_log is not None:
            entry = {
                "car_id": len(self.event_log["cars"]) + 1,
                "kind": car["kind"], "arrival": car["arrival"],
                "patience": car["patience"], "outcome": None,
                "assign_time": None, "spot_index": None, "search_minutes": None,
                "park_start": None, "leave_time": None,
                "price_per_hour": None, "fee": 0.0, "give_up_time": None,
            }
            self.event_log["cars"].append(entry)
        deadline = min(car["arrival"] + car["patience"], SIMULATION_MINUTES)
        available = self.free_spots(car["kind"])

        # Simple polling keeps the waiting logic easy to explain.
        # At equal retry times SimPy's event order decides who checks first.
        while not available and self.env.now < deadline:
            yield self.env.timeout(min(RECHECK_MINUTES, deadline - self.env.now))
            available = self.free_spots(car["kind"])

        if not available or self.env.now >= SIMULATION_MINUTES:
            self.turned_away += 1
            if entry is not None:
                entry.update(outcome="turned_away", give_up_time=self.env.now)
            return

        if self.mode == "Smart":
            index = min(available, key=lambda i: self.spots[i]["distance"])
            extra_search = SMART_GUIDANCE_MINUTES
        else:
            index = available[int(car["spot_choice"] * len(available))]
            extra_search = car["normal_search"]

        spot = self.spots[index]
        # Claim the spot BEFORE yielding, preventing two drivers taking it.
        # In both modes a claimed spot is unavailable during the drive to it.
        # This simplifies real-life competition between searching drivers.
        spot["busy"] = True
        self.change_occupancy(1)
        search_time = extra_search + spot["distance"] / DRIVING_SPEED_METERS_PER_MINUTE
        self.search_times.append(search_time)

        # Lock the hourly price at allocation, using occupancy INCLUDING this car.
        price = BASE_PRICE_PER_HOUR
        if (self.mode == "Smart" and
                self.busy / len(self.spots) > HIGH_OCCUPANCY_THRESHOLD):
            price *= HIGH_PRICE_MULTIPLIER

        if entry is not None:
            entry.update(outcome="parked", assign_time=self.env.now,
                         spot_index=index, search_minutes=search_time,
                         price_per_hour=price)
        yield self.env.timeout(search_time)
        if entry is not None:
            entry["park_start"] = self.env.now
        yield self.env.timeout(car["parking"])
        self.revenue += price * car["parking"] / 60  # Search/waiting are not billed.
        if entry is not None:
            entry.update(leave_time=self.env.now, fee=price * car["parking"] / 60)
        spot["busy"] = False
        self.change_occupancy(-1)

    def arrivals(self, cars):
        """Start an independent SimPy process for every arriving car."""
        for car in cars:
            yield self.env.timeout(car["arrival"] - self.env.now)
            self.env.process(self.handle_car(car))

    def console_line(self):
        """Print a small map: '.' is free, '#' is occupied or claimed."""
        minute = int(self.env.now)
        clock = f"{(START_HOUR + minute // 60) % 24:02d}:{minute % 60:02d}"
        groups = []
        for kind in ("Normal", "EV", "Reserved"):
            symbols = "".join("#" if s["busy"] else "."
                              for s in self.spots if s["kind"] == kind)
            groups.append(f"{kind}[{symbols}]")
        print(f"{self.mode:6} {clock} {' '.join(groups)} {self.busy}/{len(self.spots)}")

    def monitor(self):
        """Collect graph samples and optionally print the parking map."""
        next_console = 0
        while True:
            self.samples.append((self.env.now, 100 * self.busy / len(self.spots)))
            if self.event_log is not None:
                minute, percent = self.samples[-1]
                self.event_log["samples"].append({"minute": minute, "percent": percent})
            if self.show_console and self.env.now >= next_console:
                self.console_line()
                next_console += CONSOLE_EVERY_MINUTES
            if self.env.now >= SIMULATION_MINUTES:
                break
            yield self.env.timeout(min(SAMPLE_MINUTES, SIMULATION_MINUTES - self.env.now))


def make_part_a_layout():
    """Split capacity evenly; put all special bays on ground level (level 1)."""
    total = NORMAL_SPOTS + EV_SPOTS + RESERVED_SPOTS
    per_level = total // LEVELS
    ground_normals = per_level - EV_SPOTS - RESERVED_SPOTS
    ground_kinds = (["Normal"] * ground_normals + ["EV"] * EV_SPOTS
                    + ["Reserved"] * RESERVED_SPOTS)
    spots = []
    for level in range(1, LEVELS + 1):
        kinds = ground_kinds if level == 1 else ["Normal"] * per_level
        for position, kind in enumerate(kinds):
            horizontal = (position + 1) * DISTANCE_BETWEEN_SPOTS_METERS
            ramp = (level - 1) * RAMP_MINUTES_PER_LEVEL
            spots.append({
                "index": len(spots), "kind": kind, "level": level,
                "horizontal_distance": horizontal, "ramp_minutes": ramp,
                # Equivalent travel distance includes the time spent on ramps.
                "distance": horizontal + ramp * DRIVING_SPEED_METERS_PER_MINUTE,
                "travel_minutes": horizontal / DRIVING_SPEED_METERS_PER_MINUTE + ramp,
                "busy": False,
            })
    return spots


class PartAParkingLot(ParkingLot):
    """Opt-in model; the original ParkingLot above remains the legacy path.

    Inherit the unchanged clock, occupancy integration, arrivals and monitoring.
    Override only space eligibility and the life cycle of a car.
    """

    def __init__(self, env, mode, show_console=False, event_log=None):
        super().__init__(env, mode, show_console, event_log)
        self.spots = make_part_a_layout()
        self.entry_gate = simpy.Resource(env, capacity=1)
        self.exit_gate = simpy.Resource(env, capacity=1)
        self.records = []
        self.balked_price = 0
        self.ev_revenue = 0.0
        self.charging_now = 0
        self.max_charging = 0
        self.max_busy = 0

    def change_occupancy(self, change):
        super().change_occupancy(change)
        self.max_busy = max(self.max_busy, self.busy)
        assert 0 <= self.busy <= len(self.spots), "Parking capacity exceeded"

    def free_spots(self, kind):
        """EVs prefer chargers; normal-bay fallback is an explicit option."""
        free = [i for i, spot in enumerate(self.spots) if not spot["busy"]]
        if kind == "EV":
            chargers = [i for i in free if self.spots[i]["kind"] == "EV"]
            if chargers:
                return chargers
            return [i for i in free if self.spots[i]["kind"] == "Normal"] if EV_ALLOW_NORMAL_FALLBACK else []
        return [i for i in free if self.spots[i]["kind"] in ("Normal", kind)]

    def new_record(self, car):
        """Create the record before gate waiting, preserving arrival order."""
        record = {
            "car_id": len(self.records) + 1, "kind": car["kind"],
            "arrival": car["arrival"], "patience": car["patience"],
            "max_price_per_hour": car["max_price_per_hour"],
            "charging_minutes_requested": car["charging_minutes"],
            "outcome": None, "reason": None, "assign_time": None,
            "spot_index": None, "level": None, "search_start": None,
            "search_minutes": None, "park_start": None, "leave_time": None,
            "give_up_time": None, "price_per_hour": None, "fee": 0.0,
            "parking_fee": 0.0, "charge_start": None, "charge_end": None,
            "idle_minutes": 0.0, "charging_fee": 0.0, "idle_fee": 0.0,
            "ev_revenue": 0.0, "charge_completed": False,
            "entry_gate_wait": 0.0, "exit_gate_wait": 0.0, "gate_wait": 0.0,
            "price_refusal_time": None, "quoted_spot_index": None,
        }
        self.records.append(record)
        if self.event_log is not None:
            self.event_log["cars"].append(record)
        return record

    def pass_gate(self, record, name):
        """Resource queues are FIFO. Wait excludes the gate's service time."""
        gate = self.entry_gate if name == "entry" else self.exit_gate
        service = ENTRY_GATE_SERVICE_MINUTES if name == "entry" else EXIT_GATE_SERVICE_MINUTES
        queued_at = self.env.now
        record[f"{name}_gate_queue_time"] = queued_at
        with gate.request() as request:
            yield request
            record[f"{name}_gate_start"] = self.env.now
            wait = self.env.now - queued_at
            record[f"{name}_gate_wait"] = wait
            record["gate_wait"] += wait
            yield self.env.timeout(service)
        record[f"{name}_gate_end"] = self.env.now

    def smart_spot(self, car, record):
        """Wait for an eligible spot; quote and reserve it atomically."""
        deadline = min(self.env.now + car["patience"], SIMULATION_MINUTES)
        while self.env.now < SIMULATION_MINUTES:
            available = self.free_spots(car["kind"])
            if available:
                index = min(available, key=lambda i: self.spots[i]["distance"])
                spot = self.spots[index]
                spot["busy"] = True             # Tentative claim, before any yield.
                price = BASE_PRICE_PER_HOUR
                if (self.busy + 1) / len(self.spots) > HIGH_OCCUPANCY_THRESHOLD:
                    price *= HIGH_PRICE_MULTIPLIER
                record["price_per_hour"] = price
                if price > car["max_price_per_hour"]:
                    spot["busy"] = False        # Release immediately, no occupancy added.
                    self.balked_price += 1
                    record.update(outcome="balked_price", reason="price_limit",
                                  price_refusal_time=self.env.now,
                                  give_up_time=self.env.now, quoted_spot_index=index)
                    return None
                self.change_occupancy(1)
                record["assign_time"] = self.env.now
                record["search_start"] = self.env.now
                record["search_minutes"] = SMART_GUIDANCE_MINUTES + spot["travel_minutes"]
                return index
            if self.env.now >= deadline:
                break
            yield self.env.timeout(min(RECHECK_MINUTES, deadline - self.env.now))
        return None

    def normal_spot(self, car, record):
        """Search and travel without reserving; check the candidate on arrival.

        Patience is the EXTRA budget after the initial random search. It includes
        travel/retries, but not the entry queue or mandatory initial search.
        """
        started = self.env.now
        record["search_start"] = started
        deadline = min(started + car["normal_search"] + car["patience"], SIMULATION_MINUTES)
        if started >= deadline:
            return None
        yield self.env.timeout(min(car["normal_search"], deadline - self.env.now))
        while self.env.now < SIMULATION_MINUTES and self.env.now <= deadline:
            available = self.free_spots(car["kind"])
            if available:
                # The same random fraction chooses among the CURRENT free bays.
                index = available[int(car["spot_choice"] * len(available))]
                spot = self.spots[index]
                travel = spot["travel_minutes"]
                if self.env.now + travel > deadline:
                    yield self.env.timeout(deadline - self.env.now)
                    return None
                yield self.env.timeout(travel)  # Still no claim: another car may take it.
                if self.env.now >= SIMULATION_MINUTES:
                    return None
                if not spot["busy"]:
                    spot["busy"] = True
                    self.change_occupancy(1)
                    record.update(assign_time=self.env.now,
                                  search_minutes=self.env.now - started,
                                  price_per_hour=BASE_PRICE_PER_HOUR)
                    return index
            if self.env.now >= deadline:
                break
            yield self.env.timeout(min(NORMAL_EXTRA_SEARCH_MINUTES, deadline - self.env.now))
        return None

    def park_and_charge(self, car, record, spot):
        """One charger is attached to each EV bay; other bays cannot charge."""
        duration = car["parking"]
        if car["kind"] == "EV" and spot["kind"] == "EV":
            charging = min(car["charging_minutes"], duration)
            self.charging_now += 1
            self.max_charging = max(self.max_charging, self.charging_now)
            assert self.charging_now <= EV_SPOTS
            record["charge_start"] = self.env.now
            record["charging_fee"] = EV_SESSION_FEE
            yield self.env.timeout(charging)
            record["charge_end"] = self.env.now
            record["charge_completed"] = car["charging_minutes"] <= duration
            self.charging_now -= 1
            record["idle_minutes"] = duration - charging
            record["idle_fee"] = record["idle_minutes"] / 60 * EV_IDLE_FEE_PER_HOUR
            yield self.env.timeout(duration - charging)
        else:
            yield self.env.timeout(duration)

    def handle_car(self, car):
        record = self.new_record(car)
        yield from self.pass_gate(record, "entry")
        if self.mode == "Smart":
            index = yield from self.smart_spot(car, record)
        else:
            index = yield from self.normal_spot(car, record)

        if index is None:
            if record["outcome"] != "balked_price":
                self.turned_away += 1
                record.update(outcome="turned_away", give_up_time=self.env.now,
                              reason="closing" if self.env.now >= SIMULATION_MINUTES else "no_spot_before_deadline")
            yield from self.pass_gate(record, "exit")
            record["exit_time"] = self.env.now
            return

        spot = self.spots[index]
        record.update(outcome="parked", spot_index=index, level=spot["level"])
        self.search_times.append(record["search_minutes"])
        if self.mode == "Smart":
            yield self.env.timeout(record["search_minutes"])
        record["park_start"] = self.env.now   # Normal claims only when it reaches the bay.
        yield from self.park_and_charge(car, record, spot)
        record["leave_time"] = self.env.now   # Release before travelling to the exit gate.
        record["parking_fee"] = record["price_per_hour"] * car["parking"] / 60
        record["ev_revenue"] = record["charging_fee"] + record["idle_fee"]
        record["fee"] = record["parking_fee"] + record["ev_revenue"]
        self.revenue += record["fee"]
        self.ev_revenue += record["ev_revenue"]
        spot["busy"] = False
        self.change_occupancy(-1)
        yield self.env.timeout(spot["travel_minutes"])
        yield from self.pass_gate(record, "exit")
        record["exit_time"] = self.env.now


def simulate(mode, cars, show_console=False, event_log=None):
    env = simpy.Environment()
    lot_class = ParkingLot if LEGACY_MODE else PartAParkingLot
    lot = lot_class(env, mode, show_console, event_log)
    env.process(lot.arrivals(cars))
    env.process(lot.monitor())
    # After closing, finish existing visits so every admitted car pays and leaves.
    # Occupancy integration and graph samples stop at the observation boundary.
    env.run()
    lot.change_occupancy(0)
    parked = len(lot.search_times)
    price_balks = 0 if LEGACY_MODE else lot.balked_price
    assert parked + lot.turned_away + price_balks == len(cars)
    assert lot.busy == 0
    metrics = {
        "Mode": mode,
        "Avg search (min)": sum(lot.search_times) / parked if parked else float("nan"),
        "Avg occupancy (%)": 100 * lot.occupied_spot_minutes / (len(lot.spots) * SIMULATION_MINUTES),
        "Turned away": lot.turned_away,
        "Revenue (CU)": lot.revenue,
    }
    if not LEGACY_MODE:
        metrics.update({
            "Arrivals": len(cars), "Parked": parked, "balked_price": lot.balked_price,
            "EV revenue (CU)": lot.ev_revenue,
            "Avg gate wait (min)": sum(r["gate_wait"] for r in lot.records) / len(cars) if cars else 0.0,
        })
        assert lot.charging_now == 0
    if event_log is not None:
        event_log["counts"] = {"parked": parked, "turned_away": lot.turned_away,
                               "balked_price": price_balks, "generated": len(cars)}
    return metrics, lot.samples


def write_event_log(mode_logs):
    """Export one paired run; the JS copy also works when opening HTML locally."""
    layout = []
    for kind, count in [("Normal", NORMAL_SPOTS), ("EV", EV_SPOTS),
                        ("Reserved", RESERVED_SPOTS)]:
        for _ in range(count):
            index = len(layout)
            layout.append({"index": index, "kind": kind,
                           "distance": (index + 1) * DISTANCE_BETWEEN_SPOTS_METERS})
    if not LEGACY_MODE:
        layout = [{key: value for key, value in spot.items() if key != "busy"}
                  for spot in make_part_a_layout()]
    data = {
        "LEGACY_MODE": LEGACY_MODE,
        "layout": layout, "distance_unit": "metres", "time_unit": "minutes",
        "START_HOUR": START_HOUR, "SIMULATION_MINUTES": SIMULATION_MINUTES,
        "BASE_PRICE_PER_HOUR": BASE_PRICE_PER_HOUR,
        "HIGH_OCCUPANCY_THRESHOLD": HIGH_OCCUPANCY_THRESHOLD,
        "HIGH_PRICE_MULTIPLIER": HIGH_PRICE_MULTIPLIER,
        "EXPORT_RUN": EXPORT_RUN, "seed": SEED + EXPORT_RUN, "modes": mode_logs,
    }
    if not LEGACY_MODE:
        data["distance_definition"] = "horizontal metres + ramp minutes * driving metres/minute"
        data["part_a_settings"] = {
            "MAX_PRICE_PER_HOUR": MAX_PRICE_PER_HOUR,
            "NORMAL_EXTRA_SEARCH_MINUTES": NORMAL_EXTRA_SEARCH_MINUTES,
            "EV_CHARGING_MINUTES": EV_CHARGING_MINUTES,
            "EV_SESSION_FEE": EV_SESSION_FEE,
            "EV_IDLE_FEE_PER_HOUR": EV_IDLE_FEE_PER_HOUR,
            "EV_ALLOW_NORMAL_FALLBACK": EV_ALLOW_NORMAL_FALLBACK,
            "LEVELS": LEVELS, "RAMP_MINUTES_PER_LEVEL": RAMP_MINUTES_PER_LEVEL,
            "ENTRY_GATE_SERVICE_MINUTES": ENTRY_GATE_SERVICE_MINUTES,
            "EXIT_GATE_SERVICE_MINUTES": EXIT_GATE_SERVICE_MINUTES,
        }
    checks = []
    for mode, log in mode_logs.items():
        parked = sum(car["outcome"] == "parked" for car in log["cars"])
        turned = sum(car["outcome"] == "turned_away" for car in log["cars"])
        price_balks = sum(car["outcome"] == "balked_price" for car in log["cars"])
        generated = log["generated_cars"]
        assert parked + turned + price_balks == len(log["cars"]) == generated
        checks.append(f"{mode}: {len(log['cars'])} logged; {parked} parked + "
                      f"{turned} turned_away + {price_balks} balked_price = {generated} generated [OK]")
    text = json.dumps(data, indent=2, allow_nan=False)
    destination = result_directory() / EXPORT_FILE
    destination.write_text(text + "\n", encoding="utf-8")
    destination.with_suffix(".js").write_text("const SIM_LOG = " + text + ";\n",
                                             encoding="utf-8")
    print("Log check | " + " | ".join(checks))
    print(f"Event log: {destination}")


def draw_charts(summary, all_samples):
    """Save both requested figures next to this script."""
    fig, ax = plt.subplots(figsize=(10, 4.5))
    colors = {"Normal": "#e58b35", "Smart": "#168b86"}
    for mode in ("Normal", "Smart"):
        runs = all_samples[mode]
        times = [minute / 60 + START_HOUR for minute, _ in runs[0]]
        averages = [sum(run[i][1] for run in runs) / len(runs)
                    for i in range(len(times))]
        ax.plot(times, averages, label=mode, color=colors[mode], linewidth=2)
    ax.axhline(HIGH_OCCUPANCY_THRESHOLD * 100, color="gray", linestyle="--",
               label="Price threshold")
    ax.set(xlabel="Hour of day", ylabel="Unavailable spots (%)", ylim=(0, 105),
           title=f"Parking occupancy — average of {RUNS} runs")
    ax.legend()
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(result_directory() / "occupancy.png", dpi=160)

    # Separate axes avoid mixing minutes and money on the same scale.
    fig, axes = plt.subplots(1, 2, figsize=(10, 4.5))
    comparisons = [("Avg search (min)", "Average search time", "Minutes"),
                   ("Revenue (CU)", "Total revenue", "Currency units")]
    for ax, (column, title, unit) in zip(axes, comparisons):
        bars = ax.bar(summary.index, summary[column],
                      color=[colors[mode] for mode in summary.index])
        ax.bar_label(bars, fmt="%.2f", padding=3)
        ax.set(title=title, ylabel=unit)
        ax.margins(y=0.2)
        ax.grid(axis="y", alpha=0.2)
        ax.set_axisbelow(True)
    fig.suptitle(f"Normal vs smart parking — average of {RUNS} runs")
    fig.tight_layout()
    fig.savefig(result_directory() / "comparison.png", dpi=160)
    if SHOW_CHARTS:
        plt.show()
    plt.close("all")


def validate_config():
    """Catch common mistakes when editing the configuration."""
    assert RUNS > 0 and isinstance(RUNS, int)
    assert isinstance(EXPORT_RUN, int) and 0 <= EXPORT_RUN < RUNS
    assert all(isinstance(n, int) and n >= 0 for n in
               (NORMAL_SPOTS, EV_SPOTS, RESERVED_SPOTS))
    assert NORMAL_SPOTS + EV_SPOTS + RESERVED_SPOTS > 0
    assert SIMULATION_MINUTES > 0
    assert min(BASE_ARRIVALS_PER_HOUR, PEAK_ARRIVALS_PER_HOUR) >= 0
    assert 0 <= EV_CAR_SHARE <= 1 and 0 <= RESERVED_CAR_SHARE <= 1
    assert EV_CAR_SHARE + RESERVED_CAR_SHARE <= 1
    for low, high in (PARKING_MINUTES, PATIENCE_MINUTES, NORMAL_SEARCH_MINUTES):
        assert 0 <= low <= high
    assert min(RECHECK_MINUTES, SAMPLE_MINUTES, CONSOLE_EVERY_MINUTES,
               DRIVING_SPEED_METERS_PER_MINUTE) > 0
    assert DISTANCE_BETWEEN_SPOTS_METERS >= 0 and SMART_GUIDANCE_MINUTES >= 0
    assert BASE_PRICE_PER_HOUR >= 0 and HIGH_PRICE_MULTIPLIER >= 1
    assert 0 <= HIGH_OCCUPANCY_THRESHOLD <= 1
    if not LEGACY_MODE:
        total = NORMAL_SPOTS + EV_SPOTS + RESERVED_SPOTS
        assert isinstance(LEVELS, int) and LEVELS > 0 and total % LEVELS == 0
        assert EV_SPOTS + RESERVED_SPOTS <= total // LEVELS, "Special spots must fit on level 1"
        assert 0 <= MAX_PRICE_PER_HOUR[0] <= MAX_PRICE_PER_HOUR[1]
        assert 0 < EV_CHARGING_MINUTES[0] <= EV_CHARGING_MINUTES[1]
        assert NORMAL_EXTRA_SEARCH_MINUTES > 0
        assert min(RAMP_MINUTES_PER_LEVEL, ENTRY_GATE_SERVICE_MINUTES,
                   EXIT_GATE_SERVICE_MINUTES, EV_SESSION_FEE, EV_IDLE_FEE_PER_HOUR) >= 0


def main():
    validate_config()
    records = []
    mode_logs = {}
    all_samples = {"Normal": [], "Smart": []}
    print("LEGACY MODEL" if LEGACY_MODE else "PART A MODEL (new features enabled)")
    print("Spot map: . = free, # = occupied or claimed (first run only).")
    for run in range(RUNS):
        cars = make_cars(SEED + run)
        for mode in ("Normal", "Smart"):
            event_log = None
            if run == EXPORT_RUN:
                event_log = {"cars": [], "samples": [], "generated_cars": len(cars)}
                mode_logs[mode] = event_log
            metrics, samples = simulate(mode, cars, SHOW_CONSOLE and run == 0, event_log)
            metrics["Run"] = run + 1
            records.append(metrics)
            all_samples[mode].append(samples)

    results = pd.DataFrame(records)
    summary = results.groupby("Mode", sort=False).mean(numeric_only=True).drop(columns="Run")
    print(f"\nCOMPARISON: average of {RUNS} runs per mode\n")
    if LEGACY_MODE:
        print(summary.to_string(float_format=lambda number: f"{number:.2f}"))
    else:
        # Metric rows put EV revenue on its own row without double-counting it.
        display = summary.rename(columns={"Turned away": "turned_away"}).T
        print(display.to_string(float_format=lambda number: f"{number:.2f}"))
        print("EV revenue is charging session fees + idle fees, already included in total revenue.")
        print("Avg gate wait is entry + exit queue time per arriving car; service time is excluded.")
        print(f"Conservation checked in all {RUNS * 2} simulations: arrivals = parked + turned_away + balked_price.")
    print("\nSearch is for admitted cars and excludes entrance waiting.")
    print("Occupancy is time-weighted and includes reserved spots; Part A Normal reserves only on arrival at the bay.")
    print("Revenue includes complete visits admitted before closing, even if they end later.")
    print("Turned-away counts may be fractional because this table averages runs.")
    destination = result_directory()
    results.to_csv(destination / "individual_runs.csv", index=False)
    summary.to_csv(destination / "comparison.csv")
    if not LEGACY_MODE:
        display.to_csv(destination / "metrics_by_mode.csv")
    print(f"\nCharts and CSV results are saved in: {destination}")
    write_event_log(mode_logs)
    draw_charts(summary, all_samples)


if __name__ == "__main__":
    main()
