/**
 * The video tool's MODEL RESOLUTION order: an explicit `model` argument, then the
 * model the user pinned in the card for that mode, then the first model of the
 * tag group.
 *
 * Why this needs its own suite: the pin is a SOFT constraint. It is written by a
 * picker the user may have used weeks ago, against a catalog that can change
 * under it (a plan swap, a region switch, a model retired upstream). A stale pin
 * must therefore fall back rather than fail — while an explicit argument, which
 * the CALLER wrote for THIS call, must still fail loudly when it names a model
 * that is not in the group. Those two rules point in opposite directions, so
 * they are pinned here side by side.
 */
import { describe, expect, it } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  VIDEO_TAG_IMAGE_TO_VIDEO,
  VIDEO_TAG_TEXT_TO_VIDEO,
  WorkBuddyVideoError,
  describeVideoFailure,
} from '../src/video-gen.ts'
import { createVideoTool, type VideoToolDeps } from '../src/video-tool.ts'

/** Both video tags — what each CN model declares today. */
const MEDIA_TAGS_FOR_VIDEO = [VIDEO_TAG_TEXT_TO_VIDEO, VIDEO_TAG_IMAGE_TO_VIDEO] as const

function credential(): WorkBuddyCredential {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'copilot.tencent.com',
    uid: 'uid-1',
    source: 'dsh',
    filePath: '/tmp/auth.json',
  }
}

/** Two CN-style video models, both carrying both video tags (as measured). */
const MODELS = [
  { id: 'kling-video-v3', name: 'Kling v3', tags: [...MEDIA_TAGS_FOR_VIDEO] },
  { id: 'minimax-video-h3', name: 'MiniMax H3', tags: [...MEDIA_TAGS_FOR_VIDEO] },
]

function deps(overrides: Partial<VideoToolDeps> = {}): VideoToolDeps {
  return {
    resolveCredential: async () => credential(),
    listMediaModels: async () => MODELS,
    submitVideo: async () => ({ taskId: 'task-1', warnings: [] }),
    pollVideoTask: async () => ({ videos: ['https://cos.example/a.mp4'] }),
    downloadVideo: async () => '/tmp/a.mp4',
    logger: { warn: () => {} },
    ...overrides,
  }
}

/** Runs a text-to-video call and returns the model id it actually used. */
async function usedModel(overrides: Partial<VideoToolDeps>, model?: string): Promise<string> {
  const tool = createVideoTool(deps(overrides))
  const value = await tool.execute(
    model === undefined ? { prompt: '一只猫在弹钢琴' } : { prompt: '一只猫在弹钢琴', model },
    {},
  )
  return value['model'] as string
}

describe('video tool model resolution', () => {
  it('takes the group first model when nothing is pinned and nothing is passed', async () => {
    await expect(usedModel({})).resolves.toBe('kling-video-v3')
  })

  it('uses the pinned model when the call names none', async () => {
    const asked: string[] = []
    const model = await usedModel({
      preferredVideoModel: (_credential, tag) => {
        asked.push(tag)
        return 'minimax-video-h3'
      },
    })
    expect(model).toBe('minimax-video-h3')
    // The pin is per mode, so the tool must ask for the tag it is actually
    // about to use — asking for a fixed one would pick a text-to-video pin for an
    // image-to-video call.
    expect(asked).toEqual([VIDEO_TAG_TEXT_TO_VIDEO])
  })

  it('falls back to the group first model when the pin is no longer in the catalog', async () => {
    // The case that matters: the user pinned `minimax-video-h3` on a plan that
    // has since dropped it. Failing here would break a generation the user asked
    // for because of a preference they set earlier.
    const model = await usedModel({ preferredVideoModel: () => 'retired-video-9' })
    expect(model).toBe('kling-video-v3')
  })

  it('lets an explicit model win over the pin', async () => {
    const model = await usedModel({
      preferredVideoModel: () => 'kling-video-v3',
    }, 'minimax-video-h3')
    expect(model).toBe('minimax-video-h3')
  })

  it('does not even read the pin when the call named a model', async () => {
    let reads = 0
    await usedModel({
      preferredVideoModel: () => {
        reads += 1
        return 'kling-video-v3'
      },
    }, 'minimax-video-h3')
    expect(reads).toBe(0)
  })

  it('does not promise to clamp an out-of-range duration', async () => {
    // `resolveVideoParams` THROWS `INVALID_ARGS` outside the model's
    // minSeconds..maxSeconds. A description that said "clamped" would teach the
    // caller to send 30s and expect 5s back, then read the error as a bug.
    const tool = createVideoTool(deps())
    const seconds = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['seconds']!
    const description = seconds['description'] as string
    expect(description).toContain('报错')
    expect(description).not.toContain('夹回')
  })

  it('still fails loudly for an explicit model that is not in the group', async () => {
    // The other direction: this name came from THIS call, so a wrong one is a
    // caller error and must not be silently replaced by a different model.
    const tool = createVideoTool(deps({ preferredVideoModel: () => 'kling-video-v3' }))
    const failure = await tool.execute({ prompt: '一只猫', model: 'retired-video-9' }, {})
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkBuddyVideoError)
    expect((failure as WorkBuddyVideoError).code).toBe('NO_VIDEO_MODEL')
  })
})

/**
 * 时长校验与失败冷却。
 *
 * 用户实测撞到的是：`seconds: 1` 被上游以 HTTP 400
 * `unsupported video duration: 1 seconds, supported range: 4-15 seconds` 退回，
 * 然后工具还给这次「参数写错」记了 60 秒冷却——于是抱怨「上游返回这种错误，
 * 也要等半天」。两个根因：目录里的 `videoGeneration` 从没被用来校验（`resolveVideoParams`
 * 的第二参数一直是 undefined），以及提交阶段 4xx 被当成「已计费失败」。
 */
describe('video tool duration validation and cooldown', () => {
  /** A catalog whose entry carries the model-level videoGeneration (4..15s). */
  const CONFIGURED = [
    {
      id: 'kling-video-v3',
      name: 'Kling v3',
      tags: [...MEDIA_TAGS_FOR_VIDEO],
      videoGeneration: { defaultSeconds: 5, minSeconds: 4, maxSeconds: 15 },
    },
  ]

  it('uses the catalog videoGeneration to reject an out-of-range duration before spending anything', async () => {
    let submitted = 0
    const tool = createVideoTool(deps({
      listMediaModels: async () => CONFIGURED,
      submitVideo: async () => {
        submitted += 1
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    const failure = await tool.execute({ prompt: '一只猫', seconds: 1 }, {})
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkBuddyVideoError)
    expect((failure as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    expect((failure as WorkBuddyVideoError).message).toContain('4 到 15 秒')
    // Not a single paid request was sent.
    expect(submitted).toBe(0)
  })

  it('accepts a duration inside the catalog range', async () => {
    const seen: number[] = []
    const tool = createVideoTool(deps({
      listMediaModels: async () => CONFIGURED,
      submitVideo: async (_credential, request) => {
        seen.push(request.seconds)
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    await tool.execute({ prompt: '一只猫', seconds: 12 }, {})
    expect(seen).toEqual([12])
  })

  it('does not cool down after a submit-phase 400: nothing was created, nothing was billed', async () => {
    let submitted = 0
    const tool = createVideoTool(deps({
      submitVideo: async () => {
        submitted += 1
        throw describeVideoFailure(400, JSON.stringify({
          code: 14407,
          msg: 'Create video failed with error: unsupported video duration: 3 seconds',
        }), 'submit')
      },
    }))
    const first = await tool.execute({ prompt: '一只猫', seconds: 3 }, {})
      .then(() => undefined, (error: unknown) => error)
    expect((first as WorkBuddyVideoError).code).toBe('REJECTED')
    // The very next call must reach the upstream again instead of answering
    // "wait 58 seconds" — that wait is the whole complaint.
    const second = await tool.execute({ prompt: '一只猫', seconds: 3 }, {})
      .then(() => undefined, (error: unknown) => error)
    expect((second as WorkBuddyVideoError).code).toBe('REJECTED')
    expect(submitted).toBe(2)
  })

  it('learns the range the upstream reported and validates it locally afterwards', async () => {
    let submitted = 0
    const tool = createVideoTool(deps({
      submitVideo: async () => {
        submitted += 1
        throw describeVideoFailure(400, JSON.stringify({
          code: 14407,
          msg: 'Create video failed with error: unsupported video duration: 1 seconds, '
            + 'supported range: 4-15 seconds',
        }), 'submit')
      },
    }))
    await tool.execute({ prompt: '一只猫', seconds: 1 }, {}).catch(() => undefined)
    expect(submitted).toBe(1)
    const failure = await tool.execute({ prompt: '一只猫', seconds: 1 }, {})
      .then(() => undefined, (error: unknown) => error)
    expect((failure as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    expect((failure as WorkBuddyVideoError).message).toContain('4 到 15 秒')
    // The second attempt never left the process.
    expect(submitted).toBe(1)
  })

  it('still cools down for a failure that really may have been billed', async () => {
    const tool = createVideoTool(deps({
      submitVideo: async () => {
        throw new WorkBuddyVideoError('workbuddy video: 上游 500', 'UPSTREAM')
      },
    }))
    await tool.execute({ prompt: '一只猫' }, {}).catch(() => undefined)
    const failure = await tool.execute({ prompt: '一只猫' }, {})
      .then(() => undefined, (error: unknown) => error)
    expect((failure as WorkBuddyVideoError).code).toBe('COOLDOWN')
  })
})

