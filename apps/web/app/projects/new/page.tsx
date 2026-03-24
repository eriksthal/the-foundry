import { redirect } from "next/navigation";
import { prisma } from "@the-foundry/db";

import { requireUser } from "../../../lib/auth";

export default async function NewProjectPage() {
  await requireUser("/projects/new");

  async function createProject(formData: FormData) {
    "use server";

    await requireUser("/projects/new");

    const name = formData.get("name") as string;
    const repoUrl = formData.get("repoUrl") as string;
    const description = (formData.get("description") as string) || null;
    const defaultBranch = (formData.get("defaultBranch") as string) || "main";

    if (!name?.trim() || !repoUrl?.trim()) {
      throw new Error("Name and repo URL are required");
    }

    const project = await prisma.project.create({
      data: { name: name.trim(), repoUrl: repoUrl.trim(), description, defaultBranch },
    });

    redirect(`/projects/${project.id}`);
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">New Project</h1>

      <form action={createProject} className="space-y-4">
        <Field label="Project Name" name="name" required placeholder="my-awesome-app" />
        <Field
          label="Repository URL"
          name="repoUrl"
          required
          placeholder="https://github.com/user/repo"
        />
        <Field label="Description" name="description" placeholder="Optional description" />
        <Field label="Default Branch" name="defaultBranch" placeholder="main" />

        <button
          type="submit"
          className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500"
        >
          Create Project
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  required,
  placeholder,
}: {
  label: string;
  name: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm text-zinc-400">
        {label}
      </label>
      <input
        id={name}
        name={name}
        required={required}
        placeholder={placeholder}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
      />
    </div>
  );
}
