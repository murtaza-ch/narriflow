import type { PlainInputField, ZObject } from 'zapier-platform-core';
import { PLATFORM_LABELS } from '../types';

/** Generation and finishing settings shared by Submit Video Link and Generate Clips. */

export const GENERATION_FIELDS: PlainInputField[] = [
  {
    key: 'clipCountTarget',
    label: 'Number of Clips',
    type: 'integer',
    helpText: 'How many clips to look for, from 3 to 30. Leave empty for 10.',
  },
  {
    key: 'clipLengthPreset',
    label: 'Clip Length',
    choices: {
      auto: 'Auto',
      under_30s: 'Under 30 seconds',
      '30_to_60s': '30 to 60 seconds',
      '60_to_120s': '60 to 120 seconds',
      '120_to_180s': '120 to 180 seconds',
    },
    helpText: 'Leave empty for Auto.',
  },
  {
    key: 'specificMoments',
    label: 'Specific Moments',
    helpText: 'Describe moments to find, in up to 500 characters. For example: "every time the guest mentions pricing".',
  },
];

export const FINISHING_FIELDS: PlainInputField[] = [
  {
    key: 'finishingTopClips',
    label: 'Finish Automatically: Top Clips',
    type: 'integer',
    helpText:
      'When clips are ready, Narriflow exports this many of the best ones (1 to 10) and then fires the Finishing Ready trigger. Leave empty to skip. Needs a plan with campaign operations.',
  },
  {
    key: 'finishingMinScore',
    label: 'Finish Automatically: Minimum Virality Score',
    type: 'integer',
    helpText: 'Skip clips scoring below this, from 0 to 100. Only used with Top Clips.',
  },
  {
    key: 'finishingCopyPlatforms',
    label: 'Finish Automatically: Write Copy For',
    list: true,
    choices: PLATFORM_LABELS,
    helpText: 'Also write a caption for each exported clip on these platforms. Only used with Top Clips.',
  },
];

export interface SettingsInput {
  clipCountTarget?: number | string;
  clipLengthPreset?: string;
  specificMoments?: string;
  finishingTopClips?: number | string;
  finishingMinScore?: number | string;
  finishingCopyPlatforms?: string[] | string;
}

function integer(z: ZObject, label: string, value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new z.errors.Error(`${label} must be a whole number.`, 'invalid_input', 400);
  }
  return parsed;
}

function text(value: string | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

/** The request's `generation` object, or undefined to use the Workspace defaults. */
export function generationSettings(z: ZObject, input: SettingsInput) {
  const settings = {
    clipCountTarget: integer(z, 'Number of Clips', input.clipCountTarget),
    clipLengthPreset: text(input.clipLengthPreset),
    specificMoments: text(input.specificMoments),
  };
  const given = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
  return Object.keys(given).length > 0 ? given : undefined;
}

/** The request's `finishing` object, or undefined when the Zap doesn't ask for finishing. */
export function finishingSettings(z: ZObject, input: SettingsInput) {
  const topClips = integer(z, 'Finish Automatically: Top Clips', input.finishingTopClips);
  const minScore = integer(z, 'Finish Automatically: Minimum Virality Score', input.finishingMinScore);
  const copyPlatforms = (Array.isArray(input.finishingCopyPlatforms) ? input.finishingCopyPlatforms : String(input.finishingCopyPlatforms ?? '').split(','))
    .map((platform) => platform.trim())
    .filter(Boolean);
  if (topClips === undefined) {
    if (minScore !== undefined || copyPlatforms.length > 0) {
      throw new z.errors.Error('Set Finish Automatically: Top Clips, or clear the other finishing fields.', 'invalid_input', 400);
    }
    return undefined;
  }
  return {
    topClips,
    ...(minScore === undefined ? {} : { minScore }),
    ...(copyPlatforms.length === 0 ? {} : { copyPlatforms }),
    delivery: 'ready_to_review',
  };
}
