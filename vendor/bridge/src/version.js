// The bridge version comes from its package.json so the process health
// surface, the socket hello, and the supervisor's expected version cannot
// drift apart. Identity (root/hash/mtime) is computed with it so a same-version
// in-place upgrade is still detectable.
import { installIdentity } from './identity.js';

export const VERSION = installIdentity().version;
