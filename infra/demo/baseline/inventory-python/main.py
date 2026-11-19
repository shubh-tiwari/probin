"""Inventory service: item lookup, stock reservation, and a background restock job."""

import asyncio
import random
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

WAREHOUSES = ["blr", "del", "bom"]
RESTOCK_EVERY_SECONDS = 15

# Units in stock per warehouse.
stock: dict[str, int] = {warehouse: 400 for warehouse in WAREHOUSES}


def restock() -> None:
    """Top every warehouse back up. Slow, and it sometimes fails."""
    if random.random() < 0.1:
        raise RuntimeError("supplier feed unavailable")
    for warehouse in WAREHOUSES:
        stock[warehouse] = min(500, stock[warehouse] + random.randint(20, 60))


async def restock_forever() -> None:
    while True:
        await asyncio.sleep(RESTOCK_EVERY_SECONDS)
        # The supplier feed takes between a fraction of a second and a few seconds.
        await asyncio.sleep(random.uniform(0.2, 2.0))
        try:
            restock()
        except RuntimeError as error:
            print(f"restock failed: {error}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(restock_forever())
    yield
    task.cancel()


app = FastAPI(title="inventory", lifespan=lifespan)


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


@app.post("/inventory/reserve", status_code=201)
async def reserve(reservation: Reservation):
    """Reserves stock for an order from the warehouse that has the most."""
    await asyncio.sleep(random.uniform(0.02, 0.08))
    warehouse = max(WAREHOUSES, key=lambda w: stock[w])
    if stock[warehouse] < reservation.quantity:
        raise HTTPException(status_code=409, detail="out of stock")
    stock[warehouse] -= reservation.quantity
    return {"item_id": reservation.item_id, "warehouse": warehouse, "quantity": reservation.quantity}
