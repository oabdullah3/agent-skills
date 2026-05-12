function createExplain(args, details = {}) {
  if (!args || !args.explain) {
    return null;
  }

  return {
    selectors: details.selectors || {},
    queryPlan: details.queryPlan || {},
    fieldsRequested: details.fieldsRequested || [],
    enrichmentPlan: details.enrichmentPlan || {},
    paginationPlan: details.paginationPlan || {},
    fallbackBehavior: Array.isArray(details.fallbackBehavior) ? details.fallbackBehavior : [],
  };
}

module.exports = {
  createExplain,
};
