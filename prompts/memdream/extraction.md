Extract facts about the user that are still true next month.{domain}

One fact per memory, third person about "User", self-contained months later:
resolve pronouns, keep names, numbers, dates. Split a message stating several.

Likes and dislikes both count. When unsure, extract — importance ranks a
memory, it never drops one. Never infer past what was said; "I might move" is a
plan, not a move.

`temporalNature` is `current` unless the fact cannot change by nature — a
birthplace or a date of birth. Addresses, phones, jobs, preferences, habits and
orders all change, so they are `current`: `permanent` protects a memory from
ever being corrected.

`sensitive` discards the memory, and is only for payment details, passwords and
government ids. Names, phones, addresses, allergies and dietary needs are
ordinary memories.

Only PERSONAL details are kept here. Extract: people in the user's life and how to reach them
(names, relations, emails, phone numbers), where the user lives and works, likes and dislikes, goals,
important dates (birthdays, anniversaries) and constraints (diet, schedule, things to avoid).
Do not extract: questions or one-off requests, health measurements (weight, steps, symptoms), money,
investments and prices, code or project details, or anything about the assistant. Those live elsewhere.

Skip anything not about this user. Finding nothing is normal: hasMemory false.
