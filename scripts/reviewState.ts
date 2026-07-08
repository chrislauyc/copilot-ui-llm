import { execFileSync } from 'node:child_process';

/**
 * Marker wrapping a JSON payload embedded (invisibly, as an HTML comment) at the
 * bottom of every review-pr PR comment. Used to recover state on the next run
 * without any external/persistent storage -- CI containers are not assumed to
 * persist anything between runs, but PR comments obviously do.
 */
const STATE_MARKER_START = '<!-- review-pr:state';
const STATE_MARKER_END = '-->';

/** Only blocking findings are carried across runs -- see discussion in PR review. */
export interface PersistedBlockingFinding {
  file: string;
  line?: number;
  message: string;
}

export interface ReviewState {
  lastReviewedSha: string;
  blockingFindings: PersistedBlockingFinding[];
}

interface GhComment {
  author?: { login?: string };
  body: string;
}

/**
 * Identity gh CLI comments as this bot when authenticated via the default
 * GITHUB_TOKEN in Actions. Overridable via REVIEW_BOT_LOGIN for other setups
 * (e.g. a GitHub App with its own bot identity).
 */
function getBotLogin(): string {
  return process.env.REVIEW_BOT_LOGIN || 'github-actions[bot]';
}

/**
 * Fetches all comments on the PR and returns the most recent one authored by
 * this bot that contains a parseable state marker. Returns null if there is no
 * prior state, the marker is malformed, or the gh call fails for any reason --
 * callers should treat null as "do a full review", never as a hard error.
 */
export function loadPreviousReviewState(prNumber: string): ReviewState | null {
  let comments: GhComment[];
  try {
    const raw = execFileSync(
      'gh',
      ['pr', 'view', prNumber, '--json', 'comments'],
      { maxBuffer: 1024 * 1024 * 20 },
    ).toString();
    comments = JSON.parse(raw).comments || [];
  } catch (err) {
    console.warn('[review-pr] failed to fetch PR comments for prior state, doing full review:', (err as Error)?.message || err);
    return null;
  }

  const botLogin = getBotLogin();
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment?.author?.login !== botLogin) continue;
    const state = parseStateMarker(comment.body);
    if (state) return state;
  }
  return null;
}

function parseStateMarker(body: string): ReviewState | null {
  const startIdx = body.indexOf(STATE_MARKER_START);
  if (startIdx === -1) return null;
  const endIdx = body.indexOf(STATE_MARKER_END, startIdx);
  if (endIdx === -1) return null;

  const jsonText = body.slice(startIdx + STATE_MARKER_START.length, endIdx).trim();
  try {
    const parsed = JSON.parse(jsonText);
    if (
      typeof parsed?.lastReviewedSha !== 'string' ||
      !Array.isArray(parsed?.blockingFindings)
    ) {
      return null;
    }
    return parsed as ReviewState;
  } catch (err) {
    console.warn('[review-pr] found a state marker but could not parse it, ignoring:', (err as Error)?.message || err);
    return null;
  }
}

/** Renders the hidden state block to append to the bottom of a new PR comment. */
export function renderStateMarker(state: ReviewState): string {
  return `${STATE_MARKER_START}\n${JSON.stringify(state)}\n${STATE_MARKER_END}`;
}

/**
 * Checks whether `sha` is a commit reachable in the local checkout. Used to
 * guard against force-pushes/rebases that drop the previously-reviewed commit,
 * or shallow clones that never had it in the first place.
 */
export function isCommitReachable(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
