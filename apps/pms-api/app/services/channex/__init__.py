"""Channex sync subsystem.

Split from the previous monolithic ``channex_sync_service`` module —
``provisioning``, ``ari_push``, ``orchestrator``, ``inbound``, ``outbound``,
each focused on one responsibility.

The legacy ``app.services.channex_sync_service`` module re-exports the
public API for backward compat.
"""
