import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const questionId = z.enum(['service', 'endpoint', 'percentile', 'requests']);

/** One request in the query test set, with what a correct answer looks like. */
export const caseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** What the person types. */
  request: z.string().min(1),
  /** The answer to give if a question is asked, by question. */
  answers: z.partialRecord(questionId, z.string()).default({}),
  expect: z.strictObject({
    /** `draft`: a tested panel. `no_match`: say nothing matches; never guess. */
    outcome: z.enum(['draft', 'no_match']),
    /** The questions that must be asked, in order. Omit to accept any (within the limit). */
    asks: z.array(questionId).optional(),
    /** A query that gives the right answer. The draft's query must return the same data. */
    reference: z.string().min(1).optional(),
    /** The time range the draft must carry. `null`: it must carry none. */
    range: z.string().nullable().optional(),
    type: z.enum(['timeseries', 'bar', 'stat']).optional(),
    /** Assumptions the draft must state. */
    assumptions: z.array(z.string()).optional(),
  }),
});
export type EvalCase = z.infer<typeof caseSchema>;

export function loadCases(path: string): EvalCase[] {
  const cases = z.array(caseSchema).parse(parseYaml(readFileSync(path, 'utf8')));
  const ids = cases.map((one) => one.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Duplicate case id "${duplicate}" in ${path}`);
  for (const one of cases) {
    if (one.expect.outcome === 'draft' && !one.expect.reference) {
      throw new Error(`Case ${one.id} expects a draft and needs a reference query.`);
    }
  }
  return cases;
}
