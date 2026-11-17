import { serialQueue } from "@app-story/shared";

/**
 * When several videos are made at once, their CPU-heavy or timing-sensitive phases (speech,
 * recording, rendering) take turns. A recording that competes for the CPU drops frames, and
 * two renders at once are no faster than one after the other. AI planning, which mostly waits
 * on the network, still overlaps freely.
 */
export const exclusive = serialQueue();
