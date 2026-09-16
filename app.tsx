import type { FormEvent } from "react";
import { useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type PluginFileOpenerProps,
  type PluginMessageDirectiveProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "./contract";
import {
  AnimationDirective,
  AnimationOpener,
} from "./src/components/AnimationEditor";
import { ensureSceneJsonPath } from "./src/template";
import "./app.css";

function NewAnimationPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [relativePath, setRelativePath] = useState("explainer.scene.json");
  const [pending, setPending] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      const result = await rpc.call("create_file", {
        threadId,
        relativePath: ensureSceneJsonPath(relativePath),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`Created ${result.path}`);
      navigate.experimental_openFilePreview({
        target: {
          kind: "workspace",
          environmentId: result.environmentId,
          path: result.path,
        },
        location: null,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={create} className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">
        Creates a starter <code>.scene.json</code> in this thread&apos;s
        workspace, then opens the animation editor.
      </p>
      <Input
        value={relativePath}
        onChange={(event) => setRelativePath(event.target.value)}
        aria-label="Animation path"
      />
      <Button type="submit" disabled={pending || relativePath.trim() === ""}>
        Create animation
      </Button>
    </form>
  );
}

function SettingsSection() {
  return (
    <div className="space-y-3 text-sm text-muted-foreground">
      <p>
        There is nothing to configure. Open a <code>.scene.json</code> file to
        play it in the Animation editor.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Create a starter file from a thread&apos;s Actions list, the command
          palette (<code>Animation: create .scene.json</code>), or{" "}
          <code>bb animation new</code>.
        </li>
        <li>
          Export a looping page with the editor&apos;s Export button,{" "}
          <code>bb animation export</code>, or{" "}
          <code>animation_export_html</code>.
        </li>
        <li>
          Embed a live preview in chat with{" "}
          <code>::scene{"{file=\"docs/flow.scene.json\"}"}</code>.
        </li>
        <li>
          Pin the opener under Settings → File openers if another JSON viewer
          wins.
        </li>
      </ul>
    </div>
  );
}

function FileOpenerSlot(props: PluginFileOpenerProps) {
  return (
    <AnimationOpener
      path={props.path}
      source={props.source}
      Original={props.Original}
    />
  );
}

function DirectiveSlot(props: PluginMessageDirectiveProps) {
  return (
    <AnimationDirective
      attributes={props.attributes}
      source={props.source}
      message={props.message}
      openWorkspaceFile={props.openWorkspaceFile}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "about",
    title: "Using Animation",
    description:
      "Open .scene.json files in the editor. There are no connection settings.",
    component: SettingsSection,
  });

  app.slots.fileOpener({
    id: "scene-json",
    title: "Animation editor",
    extensions: ["json"],
    component: FileOpenerSlot,
  });

  app.slots.messageDirective({
    id: "scene",
    component: DirectiveSlot,
  });
  app.slots.messageDirective({
    id: "animation",
    component: DirectiveSlot,
  });

  app.slots.threadPanelAction({
    id: "new-animation",
    title: "New animation",
    component: NewAnimationPanel,
  });

  app.slots.commandPaletteAction({
    id: "new-animation",
    title: "Animation: create .scene.json",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      openPanel({
        actionId: "new-animation",
        title: "New animation",
      });
    },
  });

  app.composer.customize({
    id: "animation-embed",
    plusMenu: [
      {
        id: "embed-animation",
        label: "Embed scene",
        description: "Insert an inline ::scene preview directive",
        run: ({ composer }) => {
          composer.updateText(
            (current) =>
              `${current}${current.trim() === "" ? "" : "\n\n"}::scene{file="name.scene.json"}`,
          );
        },
      },
    ],
  });
});
