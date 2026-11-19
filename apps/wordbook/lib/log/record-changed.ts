import { LOG_DELETED_EVENT } from "./delete";
import { LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT } from "./record";
import { SYNC_LANDED_EVENT } from "../sync/driver";

// The four moments the reader's record changes under a mounted screen: a lookup lands, a wipe, a delete,
// a pull from another device. Every screen that shows a figure drawn from the record subscribes here.
const RECORD_EVENTS = [LOG_FLUSHED_EVENT, LOG_CLEARED_EVENT, LOG_DELETED_EVENT, SYNC_LANDED_EVENT] as const;

export function onRecordChanged(listener: () => void): () => void {
  for (const name of RECORD_EVENTS) window.addEventListener(name, listener);
  return () => {
    for (const name of RECORD_EVENTS) window.removeEventListener(name, listener);
  };
}
