from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Generic, TypeVar

T = TypeVar("T")


class SingleflightGroup(Generic[T]):
    """
    Deduplicates concurrent synthesis jobs sharing the exact same `audioCacheKey`.
    If 5 callers request key `K` simultaneously, `fn()` runs once and all 5 await the same Future.
    """

    def __init__(self) -> None:
        self._in_flight: dict[str, asyncio.Future[T]] = {}
        self._lock = asyncio.Lock()

    @property
    def active_count(self) -> int:
        return len(self._in_flight)

    async def do(self, key: str, fn: Callable[[], Awaitable[T]]) -> tuple[T, bool]:
        """
        Returns `(result, shared)` where `shared=True` means caller piggybacked on an existing job.
        """
        async with self._lock:
            existing = self._in_flight.get(key)
            if existing is not None:
                fut = existing
                is_leader = False
            else:
                loop = asyncio.get_running_loop()
                fut = loop.create_future()
                self._in_flight[key] = fut
                is_leader = True

        if not is_leader:
            result = await asyncio.shield(fut)
            return result, True

        try:
            result = await fn()
            if not fut.done():
                fut.set_result(result)
            return result, False
        except BaseException as exc:
            if not fut.done():
                fut.set_exception(exc)
            raise
        finally:
            async with self._lock:
                self._in_flight.pop(key, None)
