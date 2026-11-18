import type { RenderProps } from "./props";
import type { TimelinePlan } from "./timeline";
import type { VideoTemplate } from "./templates";

/*
 * The poster: the picture a video shows before it plays. Slack, X, Discord and most players
 * show frame 0, and most ignore a cover image stored in the file, so frame 0 has to be the
 * picture. The title card fades in from the bare backdrop, so frame 0 instead draws the card
 * once its words have settled. It shows for one frame: unseen when the video plays.
 */

/** When the title card has settled (global ms): the poster, and the thumbnail file. */
export function posterTime(plan: TimelinePlan, template: VideoTemplate): number {
  return Math.max(0, Math.min(1500, plan.introEndMs - template.transitionMs - 200));
}

/** The frame the page draws for video frame `frame`: frame 0 draws the poster. */
export function drawnFrame(p: Pick<RenderProps, "fps" | "posterMs" | "recording">, frame: number): number {
  if (frame !== 0 || p.posterMs === undefined) return frame;
  const poster = Math.round((p.posterMs / 1000) * p.fps);
  // Only a title card: a worker reads the recording's frames in order, from where its chunk starts.
  const recordingFirst = Math.max(0, Math.round((p.recording.startMs / 1000) * p.fps));
  return poster > 0 && poster < recordingFirst ? poster : frame;
}
