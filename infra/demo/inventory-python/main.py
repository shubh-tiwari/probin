"""Inventory service: item lookup, stock reservation, and a background restock job."""

import asyncio
import random
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from opentelemetry import metrics
from pydantic import BaseModel

from telemetry import setup_telemetry

WAREHOUSES = ["blr", "del", "bom"]
RESTOCK_EVERY_SECONDS = 15

# Units in stock per warehouse.
stock: dict[str, int] = {warehouse: 400 for warehouse in WAREHOUSES}

# Metrics. Names, units and attributes here must match probin.yaml.
meter = metrics.get_meter("inventory")


def _observe_stock(_options):
    # WAREHOUSES is a short fixed list, so the attribute is bounded.
    for warehouse in WAREHOUSES:
        yield metrics.Observation(stock[warehouse], {"warehouse": warehouse})


meter.create_observable_gauge(
    "stock.level",
    callbacks=[_observe_stock],
    unit="{item}",
    description="Units in stock per warehouse",
)

restock_duration = meter.create_histogram(
    "stock.restock.duration",
    unit="s",
    description="Duration of the restock job",
    explicit_bucket_boundaries_advisory=[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
)


def restock() -> None:
    """Top every warehouse back up. Slow, and it sometimes fails."""
    if random.random() < 0.1:
        raise RuntimeError("supplier feed unavailable")
    for warehouse in WAREHOUSES:
        stock[warehouse] = min(500, stock[warehouse] + random.randint(20, 60))


async def restock_forever() -> None:
    while True:
        await asyncio.sleep(RESTOCK_EVERY_SECONDS)
        # One run of the job: the supplier feed, then the restock itself.
        started = time.perf_counter()
        result = "failure"
        try:
            # The supplier feed takes between a fraction of a second and a few seconds.
            await asyncio.sleep(random.uniform(0.2, 2.0))
            try:
                restock()
            except RuntimeError as error:
                print(f"restock failed: {error}")
            else:
                result = "success"
        except asyncio.CancelledError:
            # Shutdown interrupted the run: it did not finish, so do not record it.
            result = None
            raise
        finally:
            if result is not None:
                restock_duration.record(
                    time.perf_counter() - started, {"job.name": "restock", "job.result": result}
                )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(restock_forever())
    yield
    task.cancel()


app = FastAPI(title="inventory", lifespan=lifespan)
setup_telemetry(app)  # before the first request; routes are added below


class Reservation(BaseModel):
    item_id: str
    quantity: int = 1


@app.get("/inventory/items/{item_id}")
async def get_item(item_id: str):
    """Returns one item and where it is in stock."""
    await asyncio.sleep(random.uniform(0.004, 0.02))
    if item_id.startswith("missing"):
        raise HTTPException(status_code=404, detail="no such item")
    return {"item_id": item_id, "in_stock": {w: stock[w] > 0 for w in WAREHOUSES}}


@app.get("/inventory/stock")
async def get_stock():
    """Returns units in stock per warehouse."""
    await asyncio.sleep(random.uniform(0.002, 0.01))
    return stock


@app.get("/inventory/stock/history")
async def get_stock_history(days: int = 30):
    """Returns daily stock per warehouse. Reads one day at a time, so it is slow."""
    history = []
    for day in range(min(days, 30)):
        # One lookup per day, one after another.
        await asyncio.sleep(random.uniform(0.02, 0.045))
        history.append({"day": -day, **{w: max(0, stock[w] - day * 3) for w in WAREHOUSES}})
    return history


@app.post("/inventory/reserve", status_code=201)
async def reserve(reservation: Reservation):
    """Reserves stock for an order from the warehouse that has the most."""
    await asyncio.sleep(random.uniform(0.02, 0.08))
    warehouse = max(WAREHOUSES, key=lambda w: stock[w])
    if stock[warehouse] < reservation.quantity:
        raise HTTPException(status_code=409, detail="out of stock")
    stock[warehouse] -= reservation.quantity
    return {"item_id": reservation.item_id, "warehouse": warehouse, "quantity": reservation.quantity}
