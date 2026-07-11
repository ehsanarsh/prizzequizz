# PrizzeQuizz — Question Engine

## Purpose

The Question Engine provides question selection, validation, usage tracking, anti-repeat logic, and admin approval support.

## Question Selection Inputs

```ts
interface QuestionRequest {
  userId: string;
  matchId: string;
  modeId: string;
  category?: string;
  difficulty?: "easy" | "medium" | "hard";
  tags?: string[];
  excludeQuestionIds?: string[];
  locale: string;
}
```

## Selection Pipeline

```text
1. Load active approved questions
2. Filter by locale
3. Filter by mode compatibility
4. Filter by category / tags if requested
5. Apply difficulty curve
6. Exclude questions used in current match
7. Exclude recently seen user questions
8. Weight by freshness and performance
9. Randomly select from weighted pool
10. Record question usage
```

## Difficulty Scaling

Mode config defines difficulty progression.

Example:

```json
{
  "difficultyCurve": ["easy", "easy", "medium", "medium", "hard"]
}
```

If exact difficulty is unavailable, the engine can fallback to neighboring difficulty levels.

## Anti-Repeat Rules

Question repeat is prevented at multiple levels:

- Same match: never repeat.
- Same user: avoid within configured window.
- Same category: allow only if pool is small.
- Same exact text: blocked by duplicate detection.

## Randomization

Use weighted random selection, not pure random.

Weights can include:

- Low recent usage.
- Good answer distribution.
- Admin priority.
- Seasonal tags.
- Difficulty target.

## Answer Validation

Server receives selected option index or option id.

Validation returns:

```ts
interface AnswerResult {
  correct: boolean;
  correctIndex: number;
  selectedIndex: number;
  answerTimeMs: number;
}
```

Correct answer is never sent before resolution.

## Approval System

Question statuses:

```text
draft
pending
approved
rejected
archived
```

Only approved questions are served.

## Bulk Import / Export

Supported formats:

- JSON
- CSV

CSV columns:

```text
text, option_a, option_b, option_c, option_d, correct_index, category, difficulty, tags, locale
```

## Versioning

Every edit creates a new version. Match records store question version.

## Analytics

Track:

- Times served.
- Correct rate.
- Average answer time.
- Option distribution.
- Reports.
- Rejection reason.
