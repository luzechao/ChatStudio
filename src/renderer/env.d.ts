import type { ChatStudioAPI } from "../shared/contracts.js";

declare global {
  interface Window { chatstudio: ChatStudioAPI; }
}
