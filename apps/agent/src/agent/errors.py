"""Errors the agent raises on purpose."""

from typing import Literal


class InvalidEventError(Exception):
    """The request was sent an event it cannot take in its current state."""


class SpecValidationError(Exception):
    """A spec failed the shared schema. The message is the schema's own."""


class UnsafeUrlError(Exception):
    """A data source's URL points somewhere it must not (a private or reserved address)."""


ToolRule = Literal['catalog_grounding', 'dry_run_before_display', 'question_limit']


class ToolRefusal(Exception):
    """A tool refused to act because doing so would break a rule that must always hold."""

    def __init__(self, rule: ToolRule, message: str) -> None:
        super().__init__(message)
        self.rule = rule
