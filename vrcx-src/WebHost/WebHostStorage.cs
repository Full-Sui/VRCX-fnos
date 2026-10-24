using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VRCX;

namespace VRCXWebHost
{
    /// <summary>
    /// Bulk replace for VRCXStorage. The browser keeps a synchronous copy of the
    /// key/value store and pushes the whole object back on change.
    /// </summary>
    public sealed class WebHostStorage
    {
        public void ReplaceAll(string json)
        {
            var values = string.IsNullOrWhiteSpace(json)
                ? new Dictionary<string, string>()
                : JsonConvert.DeserializeObject<Dictionary<string, string>>(json) ?? new Dictionary<string, string>();

            VRCXStorage.Instance.Clear();
            foreach (var pair in values)
            {
                VRCXStorage.Instance.Set(pair.Key, pair.Value ?? string.Empty);
            }
            VRCXStorage.Instance.Save();
        }

        public void Apply(string json)
        {
            var payload = string.IsNullOrWhiteSpace(json) ? new JObject() : JObject.Parse(json);
            if (payload["set"] is JObject set)
            {
                foreach (var pair in set)
                {
                    VRCXStorage.Instance.Set(pair.Key, pair.Value?.ToString() ?? string.Empty);
                }
            }
            if (payload["remove"] is JArray remove)
            {
                foreach (var item in remove)
                {
                    VRCXStorage.Instance.Remove(item.ToString());
                }
            }
            VRCXStorage.Instance.Save();
        }

        public string Dump()
        {
            return VRCXStorage.Instance.GetAll();
        }
    }
}
