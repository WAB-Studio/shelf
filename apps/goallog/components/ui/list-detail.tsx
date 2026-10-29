import type { ReactNode } from "react";

import styles from "./list-detail.module.css";

// `ArmazonListaDetalle.dc.html`: from 1024 the list sits in a 320px column
// beside its item; below, only the side `show` names is drawn. It sets no
// width on the page: a screen using it passes `Page width="full"`.
export function ListDetail({
  list,
  detail,
  show,
}: {
  list: ReactNode;
  detail: ReactNode;
  show: "list" | "detail";
}) {
  return (
    <div className={styles.frame}>
      <div className={show === "list" ? styles.list : `${styles.list} ${styles.off}`}>{list}</div>
      <div className={show === "detail" ? styles.detail : `${styles.detail} ${styles.off}`}>{detail}</div>
    </div>
  );
}
