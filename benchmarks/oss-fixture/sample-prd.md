# fixture-ms — what the product does

_Current as of commit 4ff48cec099f. Every claim in this document traces to verified code; open questions live in questions.md._

## Duration conversion

Turning lengths of time between text like 2h and plain millisecond numbers, in both directions.

### Convert duration text into milliseconds <!-- feature:FEAT-duration-parse-text -->

- **What you do:** You give a length of time as text, like 2h or 1.5 days.
- **What happens:** The text is read and multiplied into milliseconds using fixed unit sizes.
- **What you see:** You get the number of milliseconds back.

Rules that apply:
- When the text does not match the expected pattern, the result is the special not-a-number value instead of an error. <!-- fact:FACT-duration-002 -->
- Duration text that is empty, not text at all, or longer than 100 characters is rejected with an error. <!-- fact:FACT-duration-003 -->
- Unit words are recognized whether written in capital or small letters. <!-- fact:FACT-duration-004 -->

### Turn milliseconds into readable text <!-- feature:FEAT-duration-format-number -->

- **What you do:** You give a number of milliseconds.
- **What happens:** The number is matched to the largest unit of time that fits it.
- **What you see:** You get short text like 2h, or full words like 2 hours with the long option.

Rules that apply:
- With the long option, the unit is written as a full word, and an s is added when the amount is at least one and a half times the unit. <!-- fact:FACT-duration-007 -->
- A value that is not a finite number is rejected with an error before any formatting happens. <!-- fact:FACT-duration-008 -->

### Strict typed entry point <!-- feature:FEAT-duration-strict-entry -->

- **What you do:** You use the strict entry with a checked duration text.
- **What happens:** The text is handed to the same conversion the plain entry uses.
- **What you see:** You get the same number of milliseconds.

