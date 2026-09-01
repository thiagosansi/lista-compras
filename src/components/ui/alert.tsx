type AlertProps = {
  kind?: "error" | "info" | "success";
  children: React.ReactNode;
};

const styles = {
  error: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
};

export function Alert({ kind = "info", children }: AlertProps) {
  return (
    <p role={kind === "error" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${styles[kind]}`}>
      {children}
    </p>
  );
}
