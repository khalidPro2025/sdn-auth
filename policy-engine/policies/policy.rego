package sdn
default allow = false
path_str := sprintf("%v", [input.path]) { input.path != null }
path_str := "" { not input.path }
is_restconf { contains(lower(path_str), "/restconf/") }
is_restconf_operational { contains(lower(path_str), "/restconf/operational/") }
groups_list[g] { some i; input.groups[i]; g := lower(sprintf("%v", [input.groups[i]])) }
is_admin { groups_list[g]; g == "admins" }
allow { input.authenticated; input.method == "GET"; is_restconf_operational }
allow { is_admin; is_restconf }
allow { input.method == "OPTIONS" }
