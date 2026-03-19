import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.js";
import { SetupGate } from "./components/setup-gate.js";
import "./styles/global.css";

const queryClient = new QueryClient();

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SetupGate>
        <RouterProvider router={router} context={{ queryClient }} />
      </SetupGate>
    </QueryClientProvider>
  </StrictMode>,
);
