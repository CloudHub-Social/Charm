// Design-sync bundle entry. Charm is a Tauri app, not a published component
// library, so there is no dist barrel — this re-exports the src/components/ui
// primitives (and their subcomponents) that have Storybook stories, which is
// what the claude.ai/design bundle exposes on window.Charm.*.
export * from "@/components/ui/avatar";
export * from "@/components/ui/button";
export * from "@/components/ui/dialog";
export * from "@/components/ui/dropdown-menu";
export * from "@/components/ui/input";
export * from "@/components/ui/label";
export * from "@/components/ui/popover";
export * from "@/components/ui/tabs";
export * from "@/components/ui/tooltip";
