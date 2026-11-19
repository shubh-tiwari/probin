"""The agent: plain-language requests become tested queries, alerts and data sources.

The loop is a state machine driven by code; the model only parses the request
and writes the query. Every rule that must hold (catalog grounding, the dry
run before display, the question limit) is enforced by the tools, whatever
the model says.
"""
