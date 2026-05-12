const fs = require("fs");
const path = require("path");
const { CliError } = require("../errors");

function hasActionFlags(args) {
  return Boolean(
    args["comment-body"] ||
      args["worklog-time-spent"] ||
      args["start-date"] ||
      args["due-date"] ||
      args["priority-id"] ||
      args["component-ids"] ||
      args["parent-key"] ||
      args["parent-id"] ||
      args["environment-value"] ||
      args["story-points"] ||
      args["original-estimate"] ||
      args["acceptance-field-id"] ||
      args["acceptance-value"] ||
      args["attach-file"] ||
      args["get-details"] ||
      args["transition-id"] ||
      args["assignee-id"] ||
      args["link-type"] ||
      args["link-issue"] ||
      args["labels"] ||
      args["labels-add"] ||
      args["labels-remove"]
  );
}

function buildActionPlan(issueIdOrKey, args, options = {}) {
  const disableTransition = options === true || options?.disableTransition === true;
  if (args["worklog-version"] !== undefined) throw new CliError("Flag removed: --worklog-version", 3);
  if (args["details-version"] !== undefined) throw new CliError("Flag removed: --details-version", 3);
  if (args["start-field-id"] !== undefined) throw new CliError("Flag removed: --start-field-id", 3);
  if (args["acceptance-field-name"] !== undefined) throw new CliError("Flag removed: --acceptance-field-name", 3);
  if (args["details-fields"] !== undefined) throw new CliError("Flag removed: --details-fields", 3);

  const plan = [];

  // 1. Process all standard fields first
  if (args["summary"]) {
    plan.push({ kind: "summary", issue: issueIdOrKey, value: args["summary"] });
  }
  if (args["description"]) {
    plan.push({ kind: "description", issue: issueIdOrKey, value: args["description"] });
  }
  if (args["comment-body"]) {
    plan.push({ kind: "comment", issue: issueIdOrKey, payload: { body: args["comment-body"] } });
  }
  if (args["worklog-time-spent"]) {
    const payload = { timeSpent: args["worklog-time-spent"] };
    if (args["worklog-comment"]) payload.comment = args["worklog-comment"];
    if (args["worklog-started"]) payload.started = args["worklog-started"];
    plan.push({ kind: "worklog", issue: issueIdOrKey, version: 2, payload });
  }
  const dateMutation = parseDateMutationArgs(args);
  if (dateMutation) {
    plan.push({
      kind: "dates",
      issue: issueIdOrKey,
      version: 2,
      startDate: dateMutation.startDate,
      dueDate: dateMutation.dueDate,
    });
  }
  const priorityId = args["priority-id"] ? String(args["priority-id"]).trim() : "";
  if (priorityId) {
    plan.push({ kind: "priority", issue: issueIdOrKey, priorityId });
  }

  const componentIds = parseCsvFlag(args["component-ids"]);
  if (componentIds.length > 0) {
    plan.push({ kind: "components", issue: issueIdOrKey, componentIds });
  }

  const parentKey = args["parent-key"] ? String(args["parent-key"]).trim() : "";
  const parentId = args["parent-id"] ? String(args["parent-id"]).trim() : "";
  if (parentKey && parentId) {
    throw new CliError("Use only one parent selector: --parent-key or --parent-id", 3);
  }
  if (parentKey || parentId) {
    plan.push({ kind: "parent", issue: issueIdOrKey, parentKey: parentKey || undefined, parentId: parentId || undefined });
  }

  if (args["environment-value"] !== undefined) {
    const fieldId = args["environment-field-id"]
      ? validateEditableFieldIdentifier(String(args["environment-field-id"]).trim(), "--environment-field-id")
      : null;
    plan.push({
      kind: "environment",
      issue: issueIdOrKey,
      fieldId,
      fieldName: "Environment",
      value: String(args["environment-value"]),
    });
  }

  if (args["story-points"] !== undefined) {
    const numeric = Number(args["story-points"]);
    if (!Number.isFinite(numeric)) {
      throw new CliError("Invalid --story-points value. Use a numeric value.", 3);
    }
    const fieldId = args["story-points-field-id"]
      ? validateEditableFieldIdentifier(String(args["story-points-field-id"]).trim(), "--story-points-field-id")
      : null;
    plan.push({
      kind: "story-points",
      issue: issueIdOrKey,
      fieldId,
      fieldName: "Story Points",
      value: numeric,
    });
  }

  if (args["original-estimate"] !== undefined) {
    const originalEstimate = String(args["original-estimate"]).trim();
    if (!originalEstimate) {
      throw new CliError("Invalid --original-estimate value. Use Jira duration format such as 1h or 2d.", 3);
    }
    plan.push({ kind: "timetracking-estimate", issue: issueIdOrKey, originalEstimate });
  }

  if (args["acceptance-field-id"] || args["acceptance-value"]) {
    if (!args["acceptance-value"]) throw new CliError("Acceptance update requires --acceptance-value", 3);
    let fieldId = null;
    if (args["acceptance-field-id"]) {
      fieldId = String(args["acceptance-field-id"]);
      if (!fieldId.startsWith("customfield_")) throw new CliError("Invalid --acceptance-field-id", 3);
    }
    plan.push({ kind: "acceptance", issue: issueIdOrKey, version: 2, fieldId, fieldName: "Acceptance Criteria", value: args["acceptance-value"] });
  }
  if (args["attach-file"]) {
    const absPath = path.resolve(String(args["attach-file"]));
    if (!fs.existsSync(absPath)) throw new CliError(`Attachment file not found: ${absPath}`, 3);
    plan.push({ kind: "attachment", issue: issueIdOrKey, filePath: absPath, fileName: path.basename(absPath) });
  }
  if (args["assignee-id"]) {
    plan.push({ kind: "assignee", issue: issueIdOrKey, accountId: String(args["assignee-id"]) });
  }
  if (args["link-type"] || args["link-issue"]) {
    if (!args["link-type"] || !args["link-issue"]) throw new CliError("Issue linking requires both --link-type and --link-issue", 3);
    plan.push({ kind: "link", issue: issueIdOrKey, linkType: String(args["link-type"]), targetIssue: String(args["link-issue"]) });
  }
  if (args["transition-id"] && !disableTransition) {
    plan.push({ kind: "transition", issue: issueIdOrKey, transitionId: String(args["transition-id"]) });
  }

  // 2. NOW calculate mutations (before processing labels)
  const isReadAction = (a) => a.kind === "details";
  const hasMutations = plan.some(a => !isReadAction(a));

  // 3. Process Labels (Manual or Silent Stamp)
  let manualLabelsRequested = false;
  let add = [];
  let remove = [];

  if (args["labels-add"] || args["labels-remove"]) {
    add = args["labels-add"] ? String(args["labels-add"]).split(",").map(s => s.trim()).filter(Boolean) : [];
    remove = args["labels-remove"] ? String(args["labels-remove"]).split(",").map(s => s.trim()).filter(Boolean) : [];
    manualLabelsRequested = true;
  } else if (args["labels"]) {
    add = String(args["labels"]).split(",").map(s => s.trim()).filter(Boolean);
    remove = [];
    manualLabelsRequested = true;
  }

  if (manualLabelsRequested || hasMutations) {
    plan.push({
      kind: "labels",
      issue: issueIdOrKey,
      add,
      remove
    });
  }

  if (args["get-details"]) {
    plan.push({ kind: "details", issue: issueIdOrKey, version: 3, fields: "*all" });
  }

  return plan;
}

async function executeActionPlan(client, plan, dryRun) {
  if (dryRun) return { dryRun: true, actions: plan };

  const results = [];
  for (const action of plan) {
    if (action.kind === "comment") {
      const comment = await client.addComment(action.issue, action.payload, 2);
      results.push({ kind: action.kind, issue: action.issue, comment });
      continue;
    }
    if (action.kind === "worklog") {
      const worklog = await client.addWorklog(action.issue, action.payload, action.version);
      results.push({ kind: action.kind, issue: action.issue, version: action.version, worklog });
      continue;
    }
    if (action.kind === "dates") {
      const fields = await buildDateFieldsPayload(client, action.issue, {
        startDate: action.startDate,
        dueDate: action.dueDate,
      });
      await client.editIssue(action.issue, { fields }, 2);
      results.push({ kind: action.kind, issue: action.issue, updated: true, version: 2 });
      continue;
    }
    if (action.kind === "priority") {
      await client.editIssue(action.issue, { fields: { priority: { id: action.priorityId } } }, 3);
      results.push({ kind: action.kind, issue: action.issue, priorityId: action.priorityId, updated: true });
      continue;
    }
    if (action.kind === "components") {
      const components = action.componentIds.map((id) => ({ id }));
      await client.editIssue(action.issue, { fields: { components } }, 3);
      results.push({ kind: action.kind, issue: action.issue, componentIds: action.componentIds, updated: true });
      continue;
    }
    if (action.kind === "parent") {
      const parent = action.parentId ? { id: action.parentId } : { key: action.parentKey };
      await client.editIssue(action.issue, { fields: { parent } }, 3);
      results.push({ kind: action.kind, issue: action.issue, parent, updated: true });
      continue;
    }
    if (action.kind === "environment") {
      const fieldId = action.fieldId || (await resolveFieldIdByName(client, action.issue, action.fieldName));
      const payload = { fields: { [fieldId]: toAdf(action.value) } };
      await client.editIssue(action.issue, payload, 3);
      results.push({ kind: action.kind, issue: action.issue, fieldId, fieldName: action.fieldName, updated: true });
      continue;
    }
    if (action.kind === "story-points") {
      const fieldId = action.fieldId || (await resolveFieldIdByName(client, action.issue, action.fieldName));
      const payload = { fields: { [fieldId]: action.value } };
      await client.editIssue(action.issue, payload, 3);
      results.push({ kind: action.kind, issue: action.issue, fieldId, fieldName: action.fieldName, value: action.value, updated: true });
      continue;
    }
    if (action.kind === "timetracking-estimate") {
      const payload = {
        update: {
          timetracking: [
            {
              edit: {
                originalEstimate: action.originalEstimate,
              },
            },
          ],
        },
      };
      await client.editIssue(action.issue, payload, 3);
      results.push({ kind: action.kind, issue: action.issue, originalEstimate: action.originalEstimate, updated: true });
      continue;
    }
    if (action.kind === "acceptance") {
      const fieldId = action.fieldId || (await resolveFieldIdByName(client, action.issue, action.fieldName));
      const payload = { fields: { [fieldId]: action.value } };
      await client.editIssue(action.issue, payload, 2);
      results.push({ kind: action.kind, issue: action.issue, updated: true, version: 2, fieldId, fieldName: action.fieldName });
      continue;
    }
    if (action.kind === "attachment") {
      const attachment = await client.uploadAttachment(action.issue, action.filePath);
      results.push({ kind: action.kind, issue: action.issue, attachment });
      continue;
    }
    if (action.kind === "assignee") {
      await client.assignIssue(action.issue, action.accountId);
      results.push({ kind: action.kind, issue: action.issue, accountId: action.accountId, updated: true });
      continue;
    }
    if (action.kind === "link") {
      await client.linkIssue(action.linkType, action.issue, action.targetIssue);
      results.push({ kind: action.kind, issue: action.issue, linkType: action.linkType, targetIssue: action.targetIssue, updated: true });
      continue;
    }
    if (action.kind === "transition") {
      await client.transitionIssue(action.issue, action.transitionId);
      results.push({ kind: action.kind, issue: action.issue, transitionId: action.transitionId, updated: true });
      continue;
    }
    if (action.kind === "labels") {
      const issueData = await client.getIssue(action.issue, 3, "labels");
      const currentLabels = issueData?.fields?.labels || [];

      let currentStamp = -1;
      for (const lbl of currentLabels) {
        if (typeof lbl === "string" && lbl.startsWith("OpenClawed_")) {
          const num = parseInt(lbl.replace("OpenClawed_", ""), 10);
          if (!isNaN(num) && num > currentStamp) {
            currentStamp = num;
          }
        }
      }

      const nextStamp = currentStamp === -1 ? 1 : currentStamp + 1;
      const updateOps = [];

      if (currentStamp > 0) {
        updateOps.push({ remove: `OpenClawed_${currentStamp}` });
      }
      if (currentStamp !== -1) {
        updateOps.push({ remove: `OpenClawed_${currentStamp}` });
      }
      updateOps.push({ add: `OpenClawed_${nextStamp}` });

      action.remove.forEach(lbl => updateOps.push({ remove: lbl }));
      action.add.forEach(lbl => updateOps.push({ add: lbl }));

      await client.editIssue(action.issue, { update: { labels: updateOps } }, 3);
      results.push({ kind: action.kind, issue: action.issue, stamp: `OpenClawed_${nextStamp}`, updated: true });
      continue;
    }
    if (action.kind === "details") {
      const issueData = await client.getIssue(action.issue, action.version, action.fields);
      results.push({ kind: action.kind, issue: action.issue, version: action.version, fields: action.fields, issueData });
      continue;
    }
  }
  return { dryRun: false, actions: results };
}

function summarizeActionPlan(plan) {
  return plan.map((action) => {
    if (action.kind === "comment") return { kind: action.kind, issue: action.issue, body: truncate(action.payload?.body) };
    if (action.kind === "worklog") return { kind: action.kind, issue: action.issue, version: action.version, timeSpent: action.payload?.timeSpent, comment: truncate(action.payload?.comment), started: action.payload?.started };
    if (action.kind === "dates") {
      const payload = {};
      if (action.startDate) payload.startDate = action.startDate;
      if (action.dueDate) payload.dueDate = action.dueDate;
      return { kind: action.kind, issue: action.issue, payload };
    }
    if (action.kind === "priority") return { kind: action.kind, issue: action.issue, priorityId: action.priorityId };
    if (action.kind === "components") return { kind: action.kind, issue: action.issue, componentIds: action.componentIds };
    if (action.kind === "parent") return { kind: action.kind, issue: action.issue, parentKey: action.parentKey, parentId: action.parentId };
    if (action.kind === "environment") return { kind: action.kind, issue: action.issue, fieldId: action.fieldId || "<auto-resolve>", fieldName: action.fieldName, value: truncate(action.value) };
    if (action.kind === "story-points") return { kind: action.kind, issue: action.issue, fieldId: action.fieldId || "<auto-resolve>", fieldName: action.fieldName, value: action.value };
    if (action.kind === "timetracking-estimate") return { kind: action.kind, issue: action.issue, originalEstimate: action.originalEstimate };
    if (action.kind === "acceptance") return { kind: action.kind, issue: action.issue, fieldId: action.fieldId || "<auto-resolve>", fieldName: action.fieldName, value: truncate(action.value) };
    if (action.kind === "attachment") return { kind: action.kind, issue: action.issue, fileName: action.fileName };
    if (action.kind === "assignee") return { kind: action.kind, issue: action.issue, accountId: action.accountId };
    if (action.kind === "link") return { kind: action.kind, issue: action.issue, linkType: action.linkType, targetIssue: action.targetIssue };
    if (action.kind === "transition") return { kind: action.kind, issue: action.issue, transitionId: action.transitionId };
    if (action.kind === "labels") return { kind: action.kind, issue: action.issue, add: action.add?.length > 0 ? action.add : undefined, remove: action.remove?.length > 0 ? action.remove : undefined, note: "Includes OpenClawed auto-increment" };
    if (action.kind === "details") return { kind: action.kind, issue: action.issue, version: action.version, fields: action.fields };
    return action;
  });
}

function truncate(value, max = 120) {
  if (typeof value !== "string") return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function validateDate(value, flagName) {
  if (!value) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CliError(`Invalid ${flagName} format. Use YYYY-MM-DD`, 3);
}

function parseDateMutationArgs(args, options = {}) {
  const requireOne = Boolean(options.requireOne);
  const startDate = args["start-date"];
  const dueDate = args["due-date"];

  validateDate(startDate, "--start-date");
  validateDate(dueDate, "--due-date");

  if (!startDate && !dueDate) {
    if (requireOne) {
      throw new CliError("No date field supplied. Use --start-date and/or --due-date", 3);
    }
    return null;
  }

  return { startDate, dueDate };
}

async function buildDateFieldsPayload(client, issueIdOrKey, dateMutation) {
  const fields = {};
  if (dateMutation?.dueDate) {
    fields.duedate = dateMutation.dueDate;
  }
  if (dateMutation?.startDate) {
    const startFieldId = await resolveFieldIdByName(client, issueIdOrKey, "Start date");
    fields[startFieldId] = dateMutation.startDate;
  }
  return fields;
}

function mapActionsToPermissionRequirements(actions, options = {}) {
  const requirements = [];
  const list = Array.isArray(actions) ? actions : [];

  if (options.includeCreateIssue) {
    requirements.push({
      category: "create-issue",
      permissionKey: "CREATE_ISSUES",
      description: "Create issue",
    });
  }

  if (options.includeEditFields) {
    requirements.push({
      category: "edit-fields",
      permissionKey: "EDIT_ISSUES",
      description: "Edit issue fields",
    });
  }

  for (const action of list) {
    if (!action || !action.kind) continue;
    if (action.kind === "comment") {
      requirements.push({ category: "comment-add", permissionKey: "ADD_COMMENTS", description: "Add comment" });
      continue;
    }
    if (action.kind === "worklog") {
      requirements.push({ category: "worklog-add", permissionKey: "WORK_ON_ISSUES", description: "Add worklog" });
      continue;
    }
    if (action.kind === "attachment") {
      requirements.push({ category: "attachment-upload", permissionKey: "CREATE_ATTACHMENTS", description: "Upload attachment" });
      continue;
    }
    if (action.kind === "transition") {
      requirements.push({ category: "transition", permissionKey: "TRANSITION_ISSUES", description: "Transition issue" });
      continue;
    }
    if (action.kind === "assignee") {
      requirements.push({ category: "assign", permissionKey: "ASSIGN_ISSUES", description: "Assign issue" });
      continue;
    }
    if (action.kind === "link") {
      requirements.push({ category: "link", permissionKey: "LINK_ISSUES", description: "Link issue" });
      continue;
    }
    if (["summary", "description", "dates", "priority", "components", "parent", "environment", "story-points", "timetracking-estimate", "acceptance", "labels"].includes(action.kind)) {
      requirements.push({ category: "edit-fields", permissionKey: "EDIT_ISSUES", description: "Edit issue fields" });
    }
  }

  const deduped = new Map();
  for (const req of requirements) {
    const key = `${req.category}:${req.permissionKey}`;
    if (!deduped.has(key)) {
      deduped.set(key, req);
    }
  }

  return Array.from(deduped.values());
}

async function resolveFieldIdByName(client, issueIdOrKey, fieldName) {
  const editmeta = await client.getIssueEditMeta(issueIdOrKey, 2);
  const fields = editmeta?.fields || {};
  const entries = Object.entries(fields);
  for (const [fieldId, fieldSpec] of entries) {
    const name = typeof fieldSpec?.name === "string" ? fieldSpec.name : "";
    if (name.toLowerCase() === String(fieldName).toLowerCase()) return fieldId;
  }
  throw new CliError(`Unable to auto-resolve field '${fieldName}' from editmeta. You may need to pass the ID explicitly if supported.`, 6);
}

function parseCsvFlag(value) {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function validateEditableFieldIdentifier(value, flagName) {
  if (!value) {
    throw new CliError(`Invalid ${flagName}.`, 3);
  }
  if (value.startsWith("customfield_") || value === "environment") {
    return value;
  }
  throw new CliError(`Invalid ${flagName}. Expected customfield_* or environment.`, 3);
}

function toAdf(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: String(text) }],
      },
    ],
  };
}

module.exports = {
  hasActionFlags,
  buildActionPlan,
  executeActionPlan,
  summarizeActionPlan,
  truncate,
  validateDate,
  parseDateMutationArgs,
  buildDateFieldsPayload,
  mapActionsToPermissionRequirements,
};