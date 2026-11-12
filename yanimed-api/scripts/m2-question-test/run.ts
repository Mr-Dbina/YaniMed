import '../../src/config/load-local-env.js';

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AiCapReachedError, AiClient, StallWatchdogError } from './ai.js';
import { checkpointFor, readCheckpoint, resumeSelection, writeJson } from './checkpoint.js';
import {
  allocateSlots,
  attemptSlot,
  buildMetrics,
  checkD,
  distributeSlotSummary,
  emptyRejections,
  evaluateGate,
  loadSubject,
  nameTopics,
  planTopics,
  seedsFromOcr,
  TOTAL_SLOTS,
  MIN_TOPICS,
  type LoadedSubject,
} from './pipeline.js';
import { runSelftest } from './selftest.js';
import type { Letter, Metrics, Question, RejectionCounts, Slot, SlotStatus, Topic } from './types.js';
import { LETTERS } from './types.js';

const OUTPUT_DIR = join(tmpdir(), 'yanimed-m2');
const DEFAULT_TOPIC_CAP = 3;

interface CliArgs {
  subject: string | null;
  dry: boolean;
  selftest: boolean;
  resume: boolean;
  retryRejected: boolean;
  delayMs: number;
}

function parseDelayMs(raw: string | null): number {
  if (raw === null) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--delay-ms must be a non-negative integer, got "${raw}".`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`--delay-ms is too large: "${raw}".`);
  }
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  const valueAfter = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };

  return {
    subject: valueAfter('--subject'),
    dry: argv.includes('--dry'),
    selftest: argv.includes('--selftest'),
    resume: argv.includes('--resume'),
    retryRejected: argv.includes('--retry-rejected'),
    delayMs: parseDelayMs(valueAfter('--delay-ms')),
  };
}

function reviewSheet(subjectName: string, questions: Question[]): string {
  const lines: string[] = [];
  lines.push(`# M2 review sheet — ${subjectName}`);
  lines.push('');
  lines.push(`Questions: ${questions.length}`);
  lines.push('');
  lines.push('Judge each item from the cited page only. Explanations and verifier verdicts are omitted on purpose.');
  lines.push('');

  for (const [index, question] of [...questions].sort((a, b) => a.slotIndex - b.slotIndex).entries()) {
    lines.push(`## ${index + 1}. ${question.topic}`);
    lines.push('');
    lines.push(question.vignette);
    lines.push('');
    lines.push(question.leadIn);
    lines.push('');
    for (const letter of LETTERS) {
      lines.push(`${letter}. ${question.choices[letter]}`);
    }
    lines.push('');
    lines.push(`**KEY: ${question.key}**`);
    lines.push('');
    lines.push(`Document: ${question.citation.documentTitle}`);
    lines.push(`PDF page: ${question.citation.page}`);
    lines.push('Quote:');
    lines.push('');
    lines.push('> ' + question.citation.quote.replace(/\r?\n/g, '\n> '));
    lines.push('');
    lines.push('- [ ] quote is on that page');
    lines.push('- [ ] page supports the keyed answer');
    lines.push('');
  }

  return lines.join('\n');
}

function printGate(report: ReturnType<typeof evaluateGate>): void {
  console.log(`Eligible chunks: ${report.gate.eligibleChunks} (minimum ${report.gate.minChunks})`);
  console.log(`Distinct pages: ${report.gate.distinctPages} (minimum ${report.gate.minPages})`);
  console.log(`Gate: ${report.gate.passes ? 'PASS' : 'FAIL'}`);
  const entries = Object.entries(report.exclusions);
  if (entries.length === 0) {
    console.log('Exclusions: none');
  } else {
    console.log('Exclusions by reason:');
    for (const [reason, count] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${reason}: ${count}`);
    }
  }
}

function printTopics(topics: Topic[], perTopicCap: number, raisedCap: boolean): void {
  console.log(`Topics: ${topics.length} (requested ${20}, merged clusters under 3 chunks)`);
  console.log('Topic sizes:');
  for (const topic of topics) {
    console.log(`  ${topic.id + 1}. ${topic.name} — ${topic.members.length} chunks`);
  }
  console.log(`Per-topic slot cap: ${perTopicCap}${raisedCap ? ' (raised because fewer than 17 topics)' : ''}`);
}

function countLetters(slots: Slot[]): Record<Letter, number> {
  const counts: Record<Letter, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const slot of slots) counts[slot.letter] += 1;
  return counts;
}

function printSlotPlan(slots: Slot[]): void {
  const summary = distributeSlotSummary(slots);
  console.log(`Slot plan: ${slots.length} slots`);
  for (const entry of summary) {
    console.log(`  ${entry.topic}: ${entry.slots} slots, ${entry.seeds} seed chunks`);
  }
  const letters = countLetters(slots);
  console.log(`Answer letters: A=${letters.A} B=${letters.B} C=${letters.C} D=${letters.D}`);
}

function asErrorMessage(error: unknown): string {
  if (error instanceof AiCapReachedError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function runDry(subjectName: string, delayMs = 0): Promise<number> {
  const startedAt = Date.now();
  const prisma = new PrismaClient();
  const ai = new AiClient(process.env, { delayMs });

  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const loaded = await loadSubject(prisma, subjectName);
    console.log(`Subject: ${loaded.subject.name} (${loaded.subject.id})`);
    console.log(
      `READY documents: ${loaded.documents.map(document => `${document.title} [${document.embeddedChunks} chunks]`).join(', ')}`,
    );

    const report = evaluateGate(loaded.chunks);
    printGate(report);

    const planned = report.eligible.length > 0
      ? planTopics(report.eligible, loaded.subject.id)
      : { topics: [] as Topic[], perTopicCap: DEFAULT_TOPIC_CAP, raisedCap: false };
    const slots = planned.topics.length > 0 ? allocateSlots(planned.topics, planned.perTopicCap) : [];

    if (planned.topics.length > 0) {
      printTopics(planned.topics, planned.perTopicCap, planned.raisedCap);
      printSlotPlan(slots);
    }

    const models = await ai.listModels();
    console.log('OmniRoute model IDs:');
    if (models.ids.length === 0) {
      console.log(`  (none returned${models.error ? `: ${models.error}` : ''})`);
    } else {
      for (const id of models.ids) console.log(`  ${id}`);
    }
    console.log(`OMNIROUTE_VERIFIER_MODEL: ${ai.getVerifierMode() === 'dedicated' ? 'set' : 'not set'}`);

    const summary = {
      mode: 'dry',
      generatedAt: new Date().toISOString(),
      runTimeMs: Date.now() - startedAt,
      subject: loaded.subject,
      documents: loaded.documents,
      gate: report.gate,
      exclusions: report.exclusions,
      topics: planned.topics.map(topic => ({ id: topic.id, name: topic.name, size: topic.members.length })),
      topicsRaisedCap: planned.raisedCap,
      perTopicCap: planned.perTopicCap,
      slotPlan: {
        total: slots.length,
        letters: countLetters(slots),
        byTopic: distributeSlotSummary(slots),
        seeds: slots.reduce((sum, slot) => sum + slot.seedChunks.length, 0),
      },
      models: { ids: models.ids, error: models.error },
      verifierModel: ai.getVerifierMode() === 'dedicated' ? 'set' : 'not set',
    };

    const summaryPath = join(OUTPUT_DIR, 'dry-run-summary.json');
    writeJson(summaryPath, summary);
    console.log(`\nDry-run summary: ${summaryPath}`);
    console.log(`AI calls: 0 chat, 0 embedding (stored embeddings used for clustering).`);

    return report.gate.passes ? 0 : 1;
  } catch (error) {
    console.error(`Dry run stopped: ${asErrorMessage(error)}`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

async function runFull(
  subjectName: string,
  resume: boolean,
  retryRejected = false,
  delayMs = 0,
): Promise<number> {
  const startedAt = Date.now();
  const runStartedAt = new Date().toISOString();
  const prisma = new PrismaClient();
  const ai = new AiClient(process.env, { delayMs });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const checkpointPath = join(OUTPUT_DIR, 'checkpoint.json');
  const questionsPath = join(OUTPUT_DIR, 'questions.json');
  const reviewPath = join(OUTPUT_DIR, 'review-sheet.md');
  const metricsPath = join(OUTPUT_DIR, 'metrics.json');

  let loaded: LoadedSubject | null = null;
  let gateReport = evaluateGate([]);
  let topics: Topic[] = [];
  let slots: Slot[] = [];
  let perTopicCap = DEFAULT_TOPIC_CAP;
  let minDistinctTopics = MIN_TOPICS;
  let accepted: Question[] = [];
  let completed = new Set<number>();
  let slotStatuses: Record<number, SlotStatus> = {};
  let rejections: RejectionCounts = emptyRejections();
  let startedAtIso = runStartedAt;
  let incompleteReason: string | null = null;
  let resumes = 0;

  const writeCheckpoint = (reason: string | null = incompleteReason): void => {
    const current = loaded;
    if (!current) return;
    writeJson(
      checkpointPath,
      checkpointFor({
        loaded: current,
        topics,
        slots,
        accepted,
        completed,
        slotStatuses,
        perTopicCap,
        minDistinctTopics,
        startedAt: startedAtIso,
        aiCalls: ai.getUsage(),
        rejections,
        failureCounts: ai.getFailureCounts(),
        resumes,
        incompleteReason: reason,
      }),
    );
  };

  // The timer fires while a fetch is hung, which the loop cannot detect.
  ai.startWatchdog(() => {
    incompleteReason = 'stalled-no-ai-response';
    try {
      writeCheckpoint();
    } catch (error) {
      console.error(`Watchdog checkpoint write failed: ${asErrorMessage(error)}`);
    }
    console.error('\nINCOMPLETE: stalled-no-ai-response (no AI call completed for 5 minutes).');
    console.error('Last 3 calls:');
    for (const logLine of ai.getLastLogs(3)) console.error(`  ${logLine}`);
    process.exit(1);
  });

  try {
    loaded = await loadSubject(prisma, subjectName);
    console.log(`Subject: ${loaded.subject.name} (${loaded.subject.id})`);
    console.log(
      `READY documents: ${loaded.documents.map(document => `${document.title} [${document.embeddedChunks} chunks]`).join(', ')}`,
    );

    gateReport = evaluateGate(loaded.chunks);
    printGate(gateReport);

    if (!gateReport.gate.passes) {
      incompleteReason =
        `Gate failed: ${gateReport.gate.eligibleChunks} eligible chunks ` +
        `(need ${gateReport.gate.minChunks}) and ${gateReport.gate.distinctPages} distinct pages ` +
        `(need ${gateReport.gate.minPages}).`;
    } else {
      const planned = planTopics(gateReport.eligible, loaded.subject.id);
      topics = planned.topics;
      perTopicCap = planned.perTopicCap;
      minDistinctTopics = Math.min(MIN_TOPICS, topics.length);
      printTopics(topics, perTopicCap, planned.raisedCap);

      if (resume) {
        const checkpoint = readCheckpoint(checkpointPath);
        if (checkpoint) {
          if (checkpoint.subject.id !== loaded.subject.id) {
            throw new Error('Checkpoint belongs to a different Subject; rerun without --resume.');
          }
          if (checkpoint.topics.length !== topics.length) {
            throw new Error('Checkpoint does not match the current cluster plan; rerun without --resume.');
          }
          const names = new Map(checkpoint.topics.map(topic => [topic.id, topic.name]));
          topics = topics.map(topic => ({ ...topic, name: names.get(topic.id) ?? topic.name }));
          slots = checkpoint.slots;
          accepted = checkpoint.accepted;
          slotStatuses = checkpoint.slotStatuses ?? {};

          const selection = resumeSelection(checkpoint, retryRejected);
          completed = selection.completed;

          ai.restoreUsage(checkpoint.aiCalls);
          ai.restoreFailureCounts(checkpoint.failureCounts);
          if (checkpoint.rejections) rejections = checkpoint.rejections;
          resumes = (checkpoint.resumes ?? 0) + 1;

          perTopicCap = checkpoint.perTopicCap;
          minDistinctTopics = checkpoint.minDistinctTopics;
          startedAtIso = checkpoint.startedAt;
          const skipNote = retryRejected
            ? 'retrying rejected slots'
            : `${selection.skippedRejected.length} rejected slot(s) skipped (use --retry-rejected to retry)`;
          console.log(
            `Resume #${resumes}: ${accepted.length} accepted, ${completed.size} completed slots; ${skipNote} (checkpoint ${checkpoint.startedAt}).`,
          );
        } else {
          console.log('Resume requested but no checkpoint found; starting fresh.');
        }
      }

      if (slots.length === 0) {
        await nameTopics(ai, topics);
        slots = allocateSlots(topics, perTopicCap);
        if (slots.length !== TOTAL_SLOTS) {
          throw new Error(`Slot allocation produced ${slots.length} slots; expected ${TOTAL_SLOTS}.`);
        }
        printSlotPlan(slots);
      }

      for (const slot of slots) {
        if (completed.has(slot.slotIndex)) continue;
        try {
          const outcome = await attemptSlot(slot, {
            ai,
            pageMap: loaded.pageMap,
            accepted,
            rejections,
          });
          if (outcome.ok) {
            accepted.push(outcome.question);
            completed.add(slot.slotIndex);
            slotStatuses[slot.slotIndex] = { status: 'accepted' };
            writeCheckpoint();
            console.log(
              `Accepted slot ${slot.slotIndex + 1}/${slots.length} (${accepted.length}/${TOTAL_SLOTS}) — ${slot.topicName}`,
            );
          } else {
            completed.add(slot.slotIndex);
            slotStatuses[slot.slotIndex] = { status: 'rejected', reason: outcome.reason };
            writeCheckpoint();
            console.log(`Rejected slot ${slot.slotIndex + 1}/${slots.length}: ${outcome.reason}`);
          }
        } catch (error) {
          if (error instanceof StallWatchdogError) {
            incompleteReason = 'stalled-no-ai-response';
            writeCheckpoint();
            console.error('\nWatchdog aborted run: no AI activity for 5 minutes. Last 3 calls:');
            for (const logLine of ai.getLastLogs(3)) console.error(`  ${logLine}`);
            throw error;
          }
          if (error instanceof AiCapReachedError) throw error;
          throw error;
        }
      }

      writeCheckpoint();

      if (accepted.length === TOTAL_SLOTS) {
        let issues = checkD(accepted, perTopicCap, minDistinctTopics, loaded.pageMap);
        const replaceable = [...new Set(issues.filter(issue => issue.slotIndex >= 0).map(issue => issue.slotIndex))];
        let replacements = 0;

        for (const slotIndex of replaceable) {
          if (replacements >= 5) break;
          const slot = slots.find(candidate => candidate.slotIndex === slotIndex);
          if (!slot) continue;
          replacements += 1;
          const comparison = accepted.filter(question => question.slotIndex !== slotIndex);
          try {
            const outcome = await attemptSlot(slot, {
              ai,
              pageMap: loaded.pageMap,
              accepted: comparison,
              rejections,
            });
            if (outcome.ok) {
              const index = accepted.findIndex(question => question.slotIndex === slotIndex);
              if (index >= 0) {
                outcome.question.id = accepted[index].id;
                accepted[index] = outcome.question;
                console.log(`Check D replacement accepted for slot ${slotIndex + 1}.`);
              }
            } else {
              console.log(`Check D replacement rejected for slot ${slotIndex + 1}: ${outcome.reason}`);
            }
          } catch (error) {
            if (error instanceof AiCapReachedError) throw error;
            throw error;
          }
        }

        writeCheckpoint();
        issues = checkD(accepted, perTopicCap, minDistinctTopics, loaded.pageMap);
        if (issues.length > 0) {
          const reasons = [...new Set(issues.map(issue => issue.reason))].join(', ');
          incompleteReason =
            `Check D failed after ${replacements} replacement(s): ${reasons}.`;
        }
      }
    }
  } catch (error) {
    incompleteReason =
      error instanceof StallWatchdogError ? 'stalled-no-ai-response' : `Run stopped: ${asErrorMessage(error)}`;
    console.error(incompleteReason);
  } finally {
    ai.stopWatchdog();
  }

  if (!incompleteReason && accepted.length < TOTAL_SLOTS) {
    incompleteReason = `Only ${accepted.length}/${TOTAL_SLOTS} questions accepted.`;
  }

  const ocrSeedUsed = loaded ? seedsFromOcr(slots, loaded, accepted) : false;
  const metrics: Metrics = buildMetrics({
    loaded: loaded ?? {
      subject: { id: '', name: subjectName, status: 'ACTIVE' },
      documents: [],
      chunks: [],
      pages: [],
      pageMap: new Map(),
    },
    gate: gateReport.gate,
    topics,
    slots,
    perTopicCap,
    accepted,
    rejections,
    ai,
    ocrSeedUsed,
    runTimeMs: Date.now() - startedAt,
    incompleteReason,
    resumes,
  });

  writeJson(questionsPath, accepted);
  writeFileSync(reviewPath, `${reviewSheet(subjectName, accepted)}\n`, { encoding: 'utf8' });
  writeJson(metricsPath, metrics);
  writeCheckpoint();

  console.log(`\nAccepted: ${accepted.length}/${TOTAL_SLOTS}`);
  if (incompleteReason) console.log(`INCOMPLETE: ${incompleteReason}`);
  else console.log('COMPLETE');
  console.log(`AI calls: ${metrics.aiCalls.total} (chat ${metrics.aiCalls.chat}, embedding ${metrics.aiCalls.embedding})`);
  console.log(`Output files:`);
  console.log(`  ${questionsPath}`);
  console.log(`  ${reviewPath}`);
  console.log(`  ${metricsPath}`);
  console.log(`  ${checkpointPath}`);

  await prisma.$disconnect();
  return incompleteReason === null && accepted.length === TOTAL_SLOTS ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.selftest) {
    return await runSelftest();
  }

  if (!args.subject) {
    console.error(
      'Missing --subject. Usage: npx tsx scripts/m2-question-test/run.ts --subject Pediatrics [--dry] [--resume [--retry-rejected]] [--delay-ms <n>]',
    );
    return 1;
  }

  if (args.dry) return runDry(args.subject, args.delayMs);
  return runFull(args.subject, args.resume, args.retryRejected, args.delayMs);
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    console.error(`Fatal: ${asErrorMessage(error)}`);
    process.exitCode = 1;
  });
