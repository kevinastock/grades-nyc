declare module "@knadh/oat/js/toast.js" {
  export function toast(
    message: string,
    title?: string,
    options?: {
      duration?: number;
      placement?:
        | "top-left"
        | "top-center"
        | "top-right"
        | "bottom-left"
        | "bottom-center"
        | "bottom-right";
      variant?: "info" | "success" | "warning" | "danger";
    },
  ): HTMLOutputElement;
}
