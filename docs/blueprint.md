# Restaurant Booking Bot — Bot specification

**Archetype:** booking

**Voice:** friendly and professional — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot for restaurant reservations that shows real-time available slots, handles date/time/party size selection, sends confirmation codes, and provides reminders. Owners get admin notifications, capacity summaries, and no-show management via their Telegram chat.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- restaurant guests
- single restaurant owner

## Success criteria

- confirmed bookings with real-time availability
- owner receives admin notifications for new bookings
- guests can reschedule/cancel via inline buttons

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu for new bookings
- **Manage Booking** (button, actor: user, callback: booking:manage) — Access existing booking actions (reschedule/cancel)
  - inputs: booking reference code
  - outputs: reschedule options, cancellation confirmation

## Flows

### New Booking Flow
_Trigger:_ /start

1. Greet and request party size
2. Show available dates (14-day window)
3. Display time slots based on table capacity
4. Collect guest contact (Telegram ID or phone)
5. Confirm with reference code
6. Send owner notification

_Data touched:_ Booking, Table, OpeningRules

### Reminder Flow
_Trigger:_ 2h before booking

1. Send reminder message
2. Include inline buttons for reschedule/cancel

_Data touched:_ Booking

### Admin Management
_Trigger:_ Owner requests booking list

1. Show today's capacity summary
2. Display upcoming bookings with actions (mark no-show)

_Data touched:_ Booking, Table

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Booking** _(retention: persistent)_ — Reservation record with status tracking
  - fields: guest_name, telegram_id, date, time, party_size, tables, reference_code, status, reminder_sent
- **Table** _(retention: persistent)_ — Restaurant table configuration
  - fields: table_id, seats
- **OpeningRules** _(retention: persistent)_ — Operational hours and constraints
  - fields: open_time, close_time, sitting_length, break_periods

## Integrations

- **Telegram** (required) — Bot API messaging
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- View upcoming bookings list
- See today's capacity summary
- Mark bookings as no-show
- Cancel bookings

## Notifications

- Guest booking confirmation
- 2-hour pre-booking reminder
- Owner new booking alert
- No-show status updates

## Permissions & privacy

- Only collect guest contact if explicitly provided
- Anonymize guest data in admin summaries
- Require opt-in for phone number collection

## Edge cases

- No available tables for requested date/time
- Guest attempts to reschedule during break periods
- Concurrent booking attempts for same slot

## Required tests

- End-to-end booking flow with availability checks
- Admin notification delivery verification
- Reminder message timing accuracy

## Assumptions

- Default 11:00-22:00 operating hours until configured
- 2-hour reminder lead time
- 15-minute slot granularity
