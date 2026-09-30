# Closing Module

Owns:

- cash_sessions closing calculations
- expenses
- daily_closings

First services:

- `openCashSession`
- `closeCashSession`
- `classifyCashVariance`
- `recordShiftExpense`
- `confirmCashHandover`
- `generateDailyClosingDraft`
- `submitDailyClosing`
- `lockDailyClosing`

Sprint 4 locked:

- first shift opening cash
- next shift handover from previous cash to leave
- cash drawer expense reduces expected cash
- non-cash expense remains report-only for drawer calculation
- variance threshold: info, note required, manager review, approval required
- daily closing aggregates closed shifts and blocks open shifts
- unchecked non-cash payments appear as non-blocking daily issue
