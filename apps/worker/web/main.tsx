import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { Landing } from "./Landing";
import "./styles.css";

// Two routes: the public landing page at "/", and the desk (sign-in required) at /app.
const isDesk = location.pathname.startsWith("/app");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>{isDesk ? <App /> : <Landing />}</ErrorBoundary>
  </StrictMode>,
);
