"""
Local stand in for the GenLayer runtime so the deterministic half of the
interpreter can be tested without a validator network.

The real `genlayer` module is provided by the GenVM at execution time and needs
a live network to run the language model. That non-deterministic half is not
what we unit test here. What we test is the part that actually protects the
user: the validation gate that takes whatever the model proposes and refuses
anything that is not one of the two real tokens, a sane amount, or a coherent
trade. To exercise that gate we let a test set the model's next answer and then
watch how the contract normalises or rejects it.

This mirrors the approach used across the reference dApps: stub the model
boundary, drive the deterministic logic hard.
"""

from __future__ import annotations

import collections.abc as _abc
from typing import Any, Callable


# Some SDK-adjacent imports expect collections.abc.Buffer, added in 3.12. Alias
# it so the shim imports cleanly on 3.10/3.11.
if not hasattr(_abc, "Buffer"):
    _abc.Buffer = Any  # type: ignore[attr-defined]


# A test sets this to control what the next exec_prompt returns. It can be a
# plain string (returned as is) or a callable taking the prompt and returning a
# string, which lets a test answer differently depending on what was asked.
_next_prompt_response: Any = "{}"


def set_prompt_response(value: Any) -> None:
    """Queue the model's answer for the next exec_prompt call in a test."""
    global _next_prompt_response
    _next_prompt_response = value


class _PublicDecorators:
    def __call__(self, fn: Callable) -> Callable:
        return fn

    @property
    def payable(self) -> "_PublicDecorators":
        return self


class _Public:
    view = _PublicDecorators()
    write = _PublicDecorators()


class _Web:
    @staticmethod
    def render(_url: str, mode: str = "text") -> str:
        return ""

    @staticmethod
    def get(_url: str) -> Any:
        return None


class _Nondet:
    web = _Web()

    @staticmethod
    def exec_prompt(_prompt: str, response_format: str | None = None) -> str:
        _ = response_format
        resp = _next_prompt_response
        if callable(resp):
            return str(resp(_prompt))
        return str(resp)


class _EqPrinciple:
    @staticmethod
    def prompt_comparative(fn: Callable[[], str], _instruction: str) -> str:
        # A single deterministic validator run is enough for offline tests; real
        # consensus across validators only matters on a live network.
        return fn()

    @staticmethod
    def prompt_non_comparative(fn: Callable[[], str], _instruction: str) -> str:
        return fn()

    @staticmethod
    def strict_eq(fn: Callable[[], Any]) -> Any:
        return fn()


class _GL:
    class Contract:
        def __new__(cls, *args: Any, **kwargs: Any) -> Any:
            # The real GenVM turns class-level storage annotations into live
            # storage before __init__ runs. Reproduce just enough of that here so
            # a contract whose __init__ is a bare `pass` still has its TreeMap and
            # DynArray fields ready to use in tests.
            instance = super().__new__(cls)
            for klass in reversed(cls.__mro__):
                for name, annotation in getattr(klass, "__annotations__", {}).items():
                    origin = getattr(annotation, "__origin__", annotation)
                    if isinstance(origin, type) and issubclass(origin, TreeMap):
                        setattr(instance, name, TreeMap())
                    elif isinstance(origin, type) and issubclass(origin, DynArray):
                        setattr(instance, name, DynArray())
            return instance

    public = _Public()
    nondet = _Nondet()
    eq_principle = _EqPrinciple()


gl = _GL()


class TreeMap(dict):
    """Good enough stand in for the on-chain ordered map in tests."""


class DynArray(list):
    pass


def u256(value: int) -> int:
    return int(value)


class Address(str):
    pass


# Re-export the names a contract pulls in via `from genlayer import *`.
__all__ = ["gl", "TreeMap", "DynArray", "u256", "Address", "set_prompt_response"]
