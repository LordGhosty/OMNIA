/** Routes shared APIs to separate tool instances and retains only opaque result ownership. */
function createToolGroup(services, routes) {
  const owners = new Map();
  function remember(tool, value) {
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value))
      owners.set(value, tool);
    else if (Array.isArray(value)) value.forEach((item) => remember(tool, item));
    else if (value && typeof value === 'object')
      Object.values(value).forEach((item) => remember(tool, item));
  }
  return new Proxy(
    {},
    {
      get(_target, method) {
        if (method === 'then') return undefined;
        if (method === 'isBusy')
          return () => Object.values(services).some((service) => service.isBusy());
        if (method === 'close')
          return () =>
            Promise.allSettled(Object.values(services).map((service) => service.close()));
        if (method === 'forTool') return (tool) => services[tool];
        if (method === 'ownerOf') return (id) => owners.get(id);
        return async (...args) => {
          const rule = routes[method];
          const tool =
            rule === 'tool'
              ? args[0]
              : rule === 'owner'
                ? owners.get(args[0])
                : rule === 'owners'
                  ? owners.get(args[0]?.[0])
                  : rule;
          if (!services[tool]) throw Error('This result expired. Select the file again.');
          if (rule === 'owners' && args[0].some((id) => owners.get(id) !== tool))
            throw Error('Results belong to different tools.');
          const value = await services[tool][method](...args);
          remember(tool, value);
          return value;
        };
      },
    },
  );
}
module.exports = { createToolGroup };
