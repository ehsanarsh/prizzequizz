# Phase 33 — Device Binding + Risk Scoring

## Scope

Phase 33 adds device binding and user risk scoring on top of the Phase 32 match-integrity foundation.

The goal is to detect and surface:

- repeated devices
- multiple accounts on the same device
- high-risk users
- limited/revoked device bindings
- integrity signals correlated with device activity

This phase is still non-blocking by default. It records and scores risk so enforcement rules can be introduced safely in a later phase.

## Backend Additions

### Domain models

```text
DeviceRecord
UserDeviceBinding
UserRiskProfile
```

### New service

```text
src/services/deviceRiskService.ts
```

The service:

- reads `x-device-id`, `x-device-fingerprint`, and `x-platform`
- hashes the device fingerprint server-side
- creates/updates device records
- binds users to devices
- detects shared devices
- emits security events for multi-account device usage
- calculates user risk score
- stores user risk profile

### New migration

```text
database/migrations/007_devices_risk.sql
```

Tables:

```text
devices
user_device_bindings
user_risk_profiles
```

### User device endpoints

```http
GET  /v1/devices/current
GET  /v1/devices
POST /v1/devices/risk/recalculate
POST /v1/devices/:bindingId/trust
```

### Admin endpoints

```http
GET   /v1/admin/devices/diagnostics
GET   /v1/admin/risk/users?limit=100
GET   /v1/admin/users/:id/devices
PATCH /v1/admin/devices/bindings/:id/status
```

Binding statuses:

```text
new
trusted
limited
revoked
```

Risk levels:

```text
low
medium
high
critical
```

## PWA Additions

### Device fingerprint helper

```text
src/features/devices/device.state.ts
```

The PWA now sends:

```http
x-device-id
x-device-fingerprint
x-platform
```

on API requests.

### Admin Devices tab

The Admin panel now includes a Devices tab with:

- device count
- binding count
- shared device count
- critical risk user count
- risk user list
- selected user's device bindings
- Trust / Limit / Revoke actions

## Risk scoring inputs

Current risk score uses:

- critical integrity signals
- warning integrity signals
- shared devices
- many devices
- limited device bindings
- revoked device bindings

## Validation

Validated with:

```bash
cd prizzequizz-api
npm run build
npm run test:integration
npm run test:realtime
npm run test:matchmaking

cd ../prizzequizz-pwa
npm run typecheck
npm run build
```

## Recommended next phase

Phase 34 should add **Reward Hold + Manual Review Queue** so high-risk paid-match rewards are held until admin review.
