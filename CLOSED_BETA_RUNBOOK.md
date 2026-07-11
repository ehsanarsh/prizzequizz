# PrizzeQuizz Closed Beta Runbook

## Goal

Run a controlled beta with invite-only access and operational visibility.

## Before launch

- Confirm API `/v1/health/deep` is OK.
- Confirm DB verification is OK.
- Confirm Admin > Beta works.
- Confirm Admin > Monitoring receives test report.
- Confirm Admin > Finance shows withdrawals and payment diagnostics.
- Confirm Admin > Support can reply to tickets.
- Confirm Admin > Anti-Cheat and Devices tabs load.

## Create beta invites

Go to:

```text
Admin > Beta
```

Create invite codes with:

```text
code: BETA-TEAM-001
max uses: 5/10/50
note: test group name
```

## User onboarding flow

1. User opens PWA.
2. User enters phone.
3. User enters OTP.
4. If closed beta is required, invite code is needed.
5. User reaches Home.
6. User can play Duel, use wallet, character, rankings, support.

## Daily beta operations

Check these Admin tabs daily:

- Monitoring: new fatal/open errors
- Finance: pending withdrawals
- Review: held rewards
- Anti-Cheat: critical signals
- Devices: shared devices and critical users
- Support: open/escalated tickets
- Beta: invite consumption

## Incident response

### Payment issue

1. Disable real payment provider or switch to maintenance if available.
2. Check Admin > Payment.
3. Check Admin > Finance.
4. Reply to affected support tickets.

### Cheating spike

1. Check Admin > Anti-Cheat.
2. Check Admin > Devices.
3. Limit or ban suspicious users.
4. Keep reward holds pending until manual review.

### Crash spike

1. Check Admin > Monitoring.
2. Resolve/triage top reports.
3. Roll back if fatal reports block login/gameplay.

## Exit criteria for public launch

- Crash rate stable.
- Payment provider verified.
- Support workload manageable.
- Anti-cheat false positives understood.
- Reward hold queue under control.
- Database verification remains OK.
