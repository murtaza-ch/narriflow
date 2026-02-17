import * as React from "react";

export function useAppReady() {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);
  return ready;
}
