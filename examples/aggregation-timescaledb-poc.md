# Aggregation Layer TimescaleDB POC

## Decision to make

Determine whether Azure Database for PostgreSQL Flexible Server with the TimescaleDB extension
can replace the current InfluxDB persistence path without weakening the aggregation layer's
fail-open behavior, operational visibility, or cost envelope.

## Current blast radius

- 10 Influx-specific exporters across 7 VPPAL applications.
- 9 time-series measurements behind the shared `IDataExporter<T>` boundary.
- 4 repository-visible Grafana dashboards using InfluxQL.
- Retention, downsampling, live dashboard consumers, and target-subscription ownership still need
  measured confirmation.

## Candidate architecture

1. VPPAL applications keep the existing fail-open exporter boundary.
2. A PostgreSQL sink adapter maps the nine measurements to typed TimescaleDB hypertables.
3. Azure PostgreSQL Flexible Server hosts the TimescaleDB extension behind private networking,
   managed identity or secrets, and explicit extension allowlisting.
4. Grafana queries are migrated and compared against the same captured workload.
5. Dual-write and replay isolate correctness, latency, cost, retention, backup, and restore tests
   before any replacement decision.

## Experiment gates

- No application-path failure when the target database is slow or unavailable.
- Equivalent aggregates and dashboard results for a captured production-shaped workload.
- During a 30-minute steady-state run and a separate database-recovery run, timestamp the same
  synthetic device-status event at VPPAL emission and at its first appearance in the operator's
  Grafana panel. The p95 emit-to-panel interval must remain at or below 60 seconds, evidenced by
  the exporter event counter, the persisted row timestamp, and an independent panel observer.
- Backup, point-in-time restore, HA, extension upgrade, and rollback are demonstrated.
- Capacity and cost remain within the stated approximately EUR 1 per device per month envelope.

## Explicit unknowns

- Eneco subscription approval and ownership for the extension and shared preload configuration.
- Production cardinality, ingest burst shape, query concurrency, and retention/downsampling policy.
- Dashboard consumers outside the four committed definitions.
- Final RPO, RTO, migration window, and rollback authority.

## POC verdict contract

The POC produces a measured go, revise, or no-go recommendation. Vendor support for the extension
is a platform prerequisite, not evidence that the VPPAL workload is fit for replacement.
