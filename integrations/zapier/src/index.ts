import zapier, { defineApp } from 'zapier-platform-core';
import authentication from './authentication';
import exportClip from './creates/export-clip';
import generateClips from './creates/generate-clips';
import proposeSocialPost from './creates/propose-social-post';
import submitVideoLink from './creates/submit-video-link';
import findProject from './searches/find-project';
import getExportDownload from './searches/get-export-download';
import autopilotEpisodeImported from './triggers/autopilot-episode-imported';
import clipsReady from './triggers/clips-ready';
import exportFinished from './triggers/export-finished';
import finishingReady from './triggers/finishing-ready';
import { hydrateClipsReady, hydrateExportFinished, hydratePostClip, hydrateProject } from './hydrators';
import { brandProfileList, socialAccountList } from './triggers/lists';
import { postNeedsAttention, postPublished } from './triggers/posts';

// The version Zapier shows for each push comes from package.json: bump it there.
const { version } = require('../package.json') as { version: string };

export default defineApp({
  version,
  platformVersion: zapier.version,
  authentication,
  // Where each trigger's `details` field is read, only for events Zapier has not delivered yet.
  hydrators: { hydrateClipsReady, hydrateExportFinished, hydrateProject, hydratePostClip },
  triggers: {
    [clipsReady.key]: clipsReady,
    [exportFinished.key]: exportFinished,
    [finishingReady.key]: finishingReady,
    [autopilotEpisodeImported.key]: autopilotEpisodeImported,
    [postPublished.key]: postPublished,
    [postNeedsAttention.key]: postNeedsAttention,
    [brandProfileList.key]: brandProfileList,
    [socialAccountList.key]: socialAccountList,
  },
  creates: {
    [submitVideoLink.key]: submitVideoLink,
    [generateClips.key]: generateClips,
    [exportClip.key]: exportClip,
    [proposeSocialPost.key]: proposeSocialPost,
  },
  searches: {
    [findProject.key]: findProject,
    [getExportDownload.key]: getExportDownload,
  },
});
