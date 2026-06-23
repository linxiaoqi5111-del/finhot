import type { Resetable } from "./lib/base"
import { behaviorEventActions } from "./modules/behavior-event/store"
import { collectionActions } from "./modules/collection/store"
import { entryActions } from "./modules/entry/store"
import { entryEmbeddingActions } from "./modules/entry-embedding/store"
import { entryQualityScoreActions } from "./modules/entry-quality-score/store"
import { entryRankScoreActions } from "./modules/entry-rank-score/store"
import { entryAiTagsActions } from "./modules/entry-tags/store"
import { feedActions } from "./modules/feed/store"
import { imageActions } from "./modules/image/store"
import { inboxActions } from "./modules/inbox/store"
import { interestClusterActions } from "./modules/interest-cluster/store"
import { listActions } from "./modules/list/store"
import { subscriptionActions } from "./modules/subscription/store"
import { summaryActions } from "./modules/summary/store"
import { translationActions } from "./modules/translation/store"
import { unreadActions } from "./modules/unread/store"
import { userActions } from "./modules/user/store"

const resets: Resetable[] = [
  feedActions,
  subscriptionActions,
  inboxActions,
  listActions,
  unreadActions,
  userActions,
  entryActions,
  entryAiTagsActions,
  entryQualityScoreActions,
  entryEmbeddingActions,
  entryRankScoreActions,
  behaviorEventActions,
  interestClusterActions,
  collectionActions,
  summaryActions,
  translationActions,
  imageActions,
]

export const resetStore = async () => {
  await Promise.all(resets.map((h) => h.reset()))
}
