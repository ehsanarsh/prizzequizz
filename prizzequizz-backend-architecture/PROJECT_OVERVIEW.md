# PrizzeQuizz — Project Overview

## Purpose

PrizzeQuizz is a scalable online quiz-game platform built around competitive real-time game modes, a dual economy, and configuration-driven game rules. The backend must support fast iteration by a small team while staying safe for long-term growth: new modes, economy changes, seasonal events, new reward types, and admin-managed question banks must be added without rewriting the core engine.

## Product Assumptions

- The game supports both **Free / Practice** and **Paid / Prize** experiences.
- Free mode uses **hearts + coins** and never exposes real-money rewards.
- Paid mode uses **wallet cash** and can expose cash prizes and withdrawals.
- Weekly leagues use tickets and may be available to both Free and Paid users depending on configuration.
- Backend is the source of truth for match results, rewards, wallet transactions, question delivery, and anti-abuse decisions.
- Client UI receives events and renders animations; it does not calculate authoritative rewards.

## Core Game Modes

### 1. Duel
Two players compete over a configured number of questions. The winner is decided by score, with optional sudden-death tie-break.

### 2. Last Survivor
Multiple players answer sequential questions. Wrong answers eliminate players. Remaining players may continue or exit according to mode rules.

### 3. All or Nothing
A group mode with collective decision-making. After a successful question, players may enter a vote phase to continue or exit as a group.

### 4. Practice
A non-cash experience that reuses the same match engine and UI flow but charges hearts/coins and pays coins/XP.

## Free vs Paid Economy

| Area | Free / Practice | Paid / Prize |
|---|---|---|
| Entry | Hearts + Coins | Wallet Cash |
| Reward | Coins + XP + Items | Cash + XP + Items |
| Header | Hearts, Coins, XP | Wallet, XP, Tickets |
| Withdrawal | Not available | Available after KYC |
| Reward Settlement | Coin ledger | Wallet ledger |

## Core Vision

PrizzeQuizz must be implemented as a **game platform**, not a single hardcoded quiz screen. The architecture should be:

- Modular by mode and feature.
- Config-driven for all tunable rules.
- Event-driven for UI sync and analytics.
- Backend-authoritative for scoring and rewards.
- Safe for high concurrency and mobile network instability.
- AI-friendly: predictable file structure, typed payloads, and explicit contracts.

## Non-Negotiable Engineering Principles

1. No mode-specific rule should live inside the generic Match Engine.
2. No UI client should calculate authoritative rewards.
3. No config change should require redeploying application code unless schema changes.
4. All match state transitions must be explicit and auditable.
5. Every reward must have a ledger entry.
6. Every admin config change must have an audit log.
7. Question selection must avoid recent repeats per user and per match.
8. Reconnect, timeout, and leave behavior must be deterministic.
