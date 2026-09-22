import {
  type ItemState,
  type JobCommandRecord,
  phaseForState,
  ShuttleError,
  toShuttleError,
} from '@shuttle-lite/core';
import { parseApprovalRequest } from '@shuttle-lite/routing';
import { destinationKeys, type WorkerContext } from './context';
import { generateReport } from './report';

const RESUMABLE_FROM: ItemState = 'PREFLIGHT';

/**
 * Operator intent arrives as commands rather than direct state writes, so the
 * worker stays the only component that changes item state
 * (docs/architecture.md section 8).
 */
export async function processCommands(ctx: WorkerContext, limit = 20): Promise<number> {
  const commands = ctx.store.claimCommands(limit);
  for (const command of commands) {
    try {
      await applyCommand(ctx, command);
      ctx.store.completeCommand(command.id);
    } catch (error) {
      const shuttleError = toShuttleError(error, 'APPROVAL_INVALID');
      ctx.logger.warn('command rejected', {
        commandId: command.id,
        type: command.type,
        category: shuttleError.category,
        message: shuttleError.message,
      });
      ctx.store.rejectCommand(command.id, `${shuttleError.category}: ${shuttleError.message}`);
    }
  }
  return commands.length;
}

async function applyCommand(ctx: WorkerContext, command: JobCommandRecord): Promise<void> {
  const job = ctx.store.getJob(command.jobId);
  if (!job) throw new ShuttleError('STATE_INVALID', `jobが存在しません: ${command.jobId}`);
  // The job in the command envelope must own the target before any routing or
  // item state is changed. Item IDs alone do not establish that relationship.
  if (
    command.type === 'APPROVE_ITEM' ||
    command.type === 'SKIP_ITEM' ||
    command.type === 'SEND_TO_REVIEW' ||
    command.type === 'RETRY_ITEM'
  ) {
    const item = ctx.store.getItem(requireString(command, 'itemId'));
    if (!item || item.jobId !== job.id) {
      throw new ShuttleError('APPROVAL_INVALID', '指定されたitemはこのjobに属していません');
    }
  }
  const telemetry = ctx.store.getProfile(job.profileId)?.snowflakeLoggingEnabled ?? true;

  switch (command.type) {
    case 'START_JOB': {
      if (job.state === 'COMPLETED') {
        throw new ShuttleError('STATE_INVALID', '完了済みjobは開始できません');
      }
      ctx.store.setJobState(job.id, 'SCANNING', {
        startedAt: job.startedAt ?? new Date().toISOString(),
        pauseRequested: false,
        lastError: null,
        lastErrorCategory: null,
      });
      ctx.store.appendEvent(
        { jobId: job.id, phase: 'SCAN', status: 'STARTED', message: 'job開始' },
        { telemetry },
      );
      return;
    }
    case 'RESCAN_JOB': {
      ctx.store.setJobState(job.id, 'SCANNING', { pauseRequested: false });
      return;
    }
    case 'PAUSE_JOB': {
      ctx.store.setPauseRequested(job.id, true);
      ctx.store.appendEvent(
        { jobId: job.id, phase: 'SCAN', status: 'PROGRESS', message: 'pauseを要求しました' },
        { telemetry },
      );
      return;
    }
    case 'RESUME_JOB': {
      ctx.store.setJobState(job.id, 'RUNNING', { pauseRequested: false });
      return;
    }
    case 'RETRY_ITEM': {
      const itemId = requireString(command, 'itemId');
      retryItem(ctx, itemId, telemetry);
      return;
    }
    case 'RETRY_FAILED': {
      for (const item of ctx.store.listItems(job.id, { states: ['FAILED'], limit: 1_000 })) {
        retryItem(ctx, item.id, telemetry);
      }
      return;
    }
    case 'SKIP_ITEM': {
      const itemId = requireString(command, 'itemId');
      const reason =
        typeof command.payload.reason === 'string'
          ? command.payload.reason
          : '操作者がskipしました';
      ctx.store.setRoutingState(itemId, 'SKIPPED');
      ctx.store.transitionItem({
        itemId,
        to: 'SKIPPED',
        telemetry,
        patch: { nextAttemptAt: null, lastError: reason },
        event: { status: 'SKIPPED', phase: 'REVIEW', humanOverride: true, message: reason },
      });
      return;
    }
    case 'SEND_TO_REVIEW': {
      const itemId = requireString(command, 'itemId');
      ctx.store.transitionItem({
        itemId,
        to: 'NEEDS_REVIEW',
        telemetry,
        event: {
          status: 'FAILED',
          phase: 'REVIEW',
          humanOverride: true,
          message: '操作者がreviewへ戻しました',
        },
      });
      return;
    }
    case 'APPROVE_ITEM': {
      approveItem(ctx, command, telemetry);
      return;
    }
    case 'GENERATE_REPORT': {
      await generateReport(ctx, job.id);
      return;
    }
    default: {
      throw new ShuttleError('STATE_INVALID', `未知のcommandです: ${command.type as string}`);
    }
  }
}

function requireString(command: JobCommandRecord, key: string): string {
  const value = command.payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ShuttleError('APPROVAL_INVALID', `commandに${key}がありません`);
  }
  return value;
}

function retryItem(ctx: WorkerContext, itemId: string, telemetry: boolean): void {
  const item = ctx.store.getItem(itemId);
  if (!item) throw new ShuttleError('STATE_INVALID', `itemが存在しません: ${itemId}`);
  if (item.state === 'COMPLETED') {
    throw new ShuttleError('STATE_INVALID', '完了済みitemは再実行できません');
  }
  const to = item.resumeState ?? RESUMABLE_FROM;
  ctx.store.transitionItem({
    itemId,
    to,
    telemetry,
    patch: {
      attempts: 0,
      nextAttemptAt: null,
      resumeState: null,
      lastError: null,
      lastErrorCategory: null,
    },
    event: {
      status: 'RETRYING',
      phase: phaseForState(to),
      humanOverride: true,
      message: `操作者が ${to} から再実行しました`,
    },
  });
}

/**
 * Approval is validated here, but the move still re-checks the file against
 * this snapshot immediately before it happens (docs/requirements.md 4.12).
 */
function approveItem(ctx: WorkerContext, command: JobCommandRecord, telemetry: boolean): void {
  const request = parseApprovalRequest(command.payload, destinationKeys(ctx));
  const item = ctx.store.getItem(request.itemId);
  if (!item) throw new ShuttleError('APPROVAL_INVALID', `itemが存在しません: ${request.itemId}`);
  if (item.state !== 'REVIEW_REQUIRED' && item.state !== 'NEEDS_REVIEW') {
    throw new ShuttleError(
      'APPROVAL_INVALID',
      `review待ちでないitemは承認できません (state=${item.state})`,
    );
  }
  if (!item.boxFileId || item.boxFileId !== request.observedBoxFileId) {
    throw new ShuttleError('APPROVAL_STALE', '承認対象のBox file IDが現在の値と一致しません');
  }
  if (item.boxSha1 !== request.observedSha1) {
    throw new ShuttleError('APPROVAL_STALE', '承認時のSHA-1が現在の値と一致しません');
  }

  const routing = ctx.store.getRouting(item.id);
  const humanOverride =
    routing?.suggestedDestinationKey !== null &&
    routing?.suggestedDestinationKey !== undefined &&
    routing.suggestedDestinationKey !== request.destinationKey;

  ctx.store.recordApproval({
    itemId: item.id,
    approvedDestinationKey: request.destinationKey,
    approvedMetadata: request.metadata as Record<string, unknown>,
    approvedBoxFileId: request.observedBoxFileId,
    approvedBoxVersionId: request.observedVersionId ?? item.boxFileVersionId,
    approvedSha1: request.observedSha1,
    operatorLabel: request.operatorLabel,
    humanOverride,
  });

  ctx.store.transitionItem({
    itemId: item.id,
    to: 'APPROVED',
    telemetry,
    patch: {
      nextAttemptAt: null,
      attempts: 0,
      lastError: null,
      lastErrorCategory: null,
      // 改名の指示は配置時に読む。指定がなければ以前の指示を残さない。
      finalName: request.finalName,
    },
    event: {
      status: 'SUCCEEDED',
      phase: 'REVIEW',
      boxFileId: item.boxFileId,
      destinationKey: request.destinationKey,
      humanOverride,
      message: `${request.operatorLabel} が承認しました`,
    },
  });
}
