import { createFileRoute } from "@tanstack/react-router";
import { TekApp } from "@/components/tek-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <TekApp />;
}
