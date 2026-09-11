// Marketing campaigns page.
import React, { useEffect, useState } from "react";
import { campaignService } from "@/services";
import {
  UptoPage, UptoHero, UptoButton, UptoInput, UptoBadge,
  UptoSpinner, UptoError, UptoEmptyState, UptoCard,
} from "@/components/UI/UptoHooks";
import { Megaphone, Plus } from "lucide-react";
import { toast } from "sonner";

const Campaigns = () => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
const [editingId, setEditingId] = useState(null);

const [draft, setDraft] = useState({
  name: "",
  audience: "all",
  steps: [
    {
      day: 0,
      subject: "",
      body: "",
    },
  ],
});
  const load = async () => {
    setLoading(true);
    try {
      const res = await campaignService.list({ limit: 100 });
      setItems(res?.items || res || []);
      setError(null);
    } catch (e) { setError(e?.message || "Failed to load"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e) => {
  e.preventDefault();

  try {
    if (editingId) {
      await campaignService.update(editingId, draft);
      toast.success("Campaign updated");
    } else {
      await campaignService.create(draft);
      toast.success("Campaign created");
    }

    setShowCreate(false);
    setEditingId(null);

    setDraft({
  name: "",
  audience: "all",
  steps: [
    {
      day: 0,
      subject: "",
      body: "",
    },
  ],
});

    load();
  } catch (err) {
    toast.error(err?.message || "Operation failed");
  }
};

  const handleLaunch = async (id) => { try { await campaignService.launch(id); load(); } catch (_) {} };
  const handlePause = async (id) => {
  try {
    await campaignService.pause(id);
    toast.success("Campaign paused");
    load();
  } catch (err) {
    toast.error(err?.message || "Pause failed");
  }
};

const handleStop = async (id) => {
  try {
    await campaignService.stop(id);
    toast.success("Campaign stopped");
    load();
  } catch (err) {
    toast.error(err?.message || "Stop failed");
  }
};

const handleResume = async (id) => {
  try {
    await campaignService.resume(id);
    toast.success("Campaign resumed");
    load();
  } catch (err) {
    toast.error(err?.message || "Resume failed");
  }
};

  const handleDelete = async (id) => {
  const ok = window.confirm("Delete this campaign?");
  if (!ok) return;

  try {
    await campaignService.remove(id);
    toast.success("Campaign deleted");
    load();
  } catch (err) {
    toast.error(err?.message || "Delete failed");
  }
};
const handleEdit = (campaign) => {
  setEditingId(campaign.id);

  setDraft({
  name: campaign.name || "",
  audience: campaign.conditions?.audience || "all",
  steps: campaign.conditions?.steps || [
    {
      day: 0,
      subject: campaign.conditions?.subject || "",
      body: campaign.conditions?.body || "",
    },
  ],
});

  setShowCreate(true);
};
  return (
    <UptoPage>
      <UptoHero
        title="Campaigns"
        subtitle="Email and marketing automation"
        actions={<UptoButton onClick={() => setShowCreate(true)}><Plus className="mr-1 h-4 w-4 inline" /> New campaign</UptoButton>}
      />
      <UptoCard>
        {loading && <UptoSpinner />}
        {error && <UptoError message={error} onRetry={load} />}
        {!loading && !error && items.length === 0 && (
          <UptoEmptyState icon={Megaphone} title="No campaigns" body="Create a campaign to reach your audience." />
        )}
        {!loading && !error && items.length > 0 && (
          <div className="space-y-2">
            {items.map((c) => (
              <div key={c.id} className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <div>
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-slate-500">
  {c.conditions?.audience || "All"} ·{" "}
{c.conditions?.steps?.length
  ? `${c.conditions.steps.length} step${c.conditions.steps.length > 1 ? "s" : ""}`
  : c.conditions?.subject || "—"}
</div>
                </div>
              <div className="flex items-center gap-2">

  <UptoBadge>
  {c.conditions?.status === "paused"
    ? "Paused"
    : c.active
      ? "Running"
      : "Draft"}
</UptoBadge>

  {c.conditions?.status === "paused" ? (
  <>
    <UptoButton variant="ghost" onClick={() => handleResume(c.id)}>
      Resume
    </UptoButton>

    <UptoButton variant="secondary" onClick={() => handleStop(c.id)}>
      Stop
    </UptoButton>
  </>
) : c.conditions?.status === "cancelled" ? (
  <span className="text-sm text-slate-500">Stopped</span>
) : !c.active ? (
  <UptoButton variant="ghost" onClick={() => handleLaunch(c.id)}>
    Launch
  </UptoButton>
) : (
  <>
    <UptoButton variant="secondary" onClick={() => handlePause(c.id)}>
      Pause
    </UptoButton>

    <UptoButton variant="secondary" onClick={() => handleStop(c.id)}>
      Stop
    </UptoButton>
  </>
)}

  <UptoButton
  variant="ghost"
  onClick={() => handleEdit(c)}
>
  Edit
</UptoButton>

  <UptoButton
    variant="danger"
    onClick={() => handleDelete(c.id)}
  >
    Delete
  </UptoButton>

</div>
              </div>
            ))}
          </div>
        )}
      </UptoCard>
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form
  onSubmit={handleCreate}
  className="bg-white dark:bg-slate-900 rounded-2xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto"
>
            <h3 className="text-lg font-semibold mb-4">
  {editingId ? "Edit campaign" : "New campaign"}
</h3>
            <div className="space-y-3">
              <UptoInput label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />

              <UptoInput
  label="Audience"
  value={draft.audience}
  onChange={(e) =>
    setDraft({ ...draft, audience: e.target.value })
  }
/>

<div className="space-y-4">
  <div className="flex items-center justify-between">
    <h4 className="font-medium">Campaign Steps</h4>

    <UptoButton
      type="button"
      variant="ghost"
      onClick={() =>
        setDraft({
          ...draft,
          steps: [
            ...draft.steps,
            {
              day: draft.steps.length === 0
                ? 0
                : draft.steps[draft.steps.length - 1].day + 1,
              subject: "",
              body: "",
            },
          ],
        })
      }
    >
      + Add Step
    </UptoButton>
  </div>

  {draft.steps.map((step, index) => (
    <div
      key={index}
      className="border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h5 className="font-medium">
          Step {index + 1}
        </h5>

        {draft.steps.length > 1 && (
          <UptoButton
            type="button"
            variant="danger"
            onClick={() =>
              setDraft({
                ...draft,
                steps: draft.steps.filter((_, i) => i !== index),
              })
            }
          >
            Remove
          </UptoButton>
        )}
      </div>

      <UptoInput
        label="Day"
        type="number"
        min="0"
        value={step.day}
        onChange={(e) => {
          const steps = [...draft.steps];
          steps[index] = {
            ...steps[index],
            day: Number(e.target.value),
          };
          setDraft({ ...draft, steps });
        }}
        required
      />

      <UptoInput
        label="Subject"
        value={step.subject}
        onChange={(e) => {
          const steps = [...draft.steps];
          steps[index] = {
            ...steps[index],
            subject: e.target.value,
          };
          setDraft({ ...draft, steps });
        }}
        required
      />

      <UptoInput
        label="Email Body"
        value={step.body}
        onChange={(e) => {
          const steps = [...draft.steps];
          steps[index] = {
            ...steps[index],
            body: e.target.value,
          };
          setDraft({ ...draft, steps });
        }}
        required
      />
    </div>
  ))}
</div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <UptoButton type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</UptoButton>
              <UptoButton type="submit">
  {editingId ? "Save Changes" : "Create"}
</UptoButton>
            </div>
          </form>
        </div>
      )}
    </UptoPage>
  );
};

export default Campaigns;
