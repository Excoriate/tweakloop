# Azure Platform Plan

## Networking

All ingress flows through the internal Application Gateway. No services are
exposed on public endpoints; agent workloads reach the platform over private
endpoints only.

## Data Platform

Time-series telemetry lands in Azure PostgreSQL Flexible Server with
TimescaleDB. Retention: 90 days hot, 2 years cold in ADLS.

## Identity

Workload identities use managed identities exclusively; no client secrets in
configuration. Human access goes through Entra ID groups with PIM.

## Open Questions

- Do we need zone redundancy for the data platform in the first region?
- Is 90 days of hot retention enough for the anomaly-detection workloads?
