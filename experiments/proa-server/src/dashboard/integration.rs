use super::{
    model::{array, number},
    tree,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;
fn strings(v: &Value) -> Vec<String> {
    let mut seen = BTreeSet::new();
    array(v)
        .iter()
        .filter_map(Value::as_str)
        .filter(|value| seen.insert(*value))
        .map(str::to_owned)
        .collect()
}
fn step(label: &str, done: bool, active: bool) -> Value {
    json!({"label":label,"state":if done {"done"} else if active {"current"} else {"pending"}})
}
fn distance(s: &Value) -> String {
    if s["prState"] == "merged" || s["prState"] == "closed" {
        return String::new();
    }
    let n = &s["nodeRestack"];
    let d = &n["distance"];
    let parent = n["observedParent"]
        .get("sha")
        .unwrap_or(&s["nodeComparison"]["parentSha"]);
    if !d.is_null()
        && d["base"] == n["contributionBase"]
        && d["branch"] == s["baseBranch"]
        && &d["parent"] == parent
    {
        if let Some(count) = d["count"].as_u64().filter(|n| *n <= 9_007_199_254_740_991) {
            return if count == 0 {
                String::new()
            } else {
                format!("+{count}")
            };
        }
    }
    "+?".into()
}
fn prospective(s: &Value, rules: &Value, labels: &[&str]) -> (String, Value) {
    let into = if s["target"].is_null() {
        "root"
    } else {
        "node"
    };
    for (index, rule) in array(rules).iter().enumerate() {
        if rule["from"].as_str().is_some_and(|from| from != "node") {
            continue;
        }
        if let Some(target) = rule["into"].as_str() {
            if target != into && !(into == "node" && s["target"]["ticket"]["id"] == target) {
                continue;
            }
        }
        if rule["label"]
            .as_str()
            .is_some_and(|label| !labels.contains(&label))
        {
            continue;
        }
        return (
            rule["mode"].as_str().unwrap_or("consent").into(),
            json!({"index":index,"snapshot":rule}),
        );
    }
    ("consent".into(), json!({"default":true}))
}
fn policy(s: &Value, rules: &Value) -> (String, String) {
    let recorded = &s["landing"]["decision"]["rule"];
    let mut candidates = vec![prospective(s, rules, &[])];
    for rule in array(rules) {
        if let Some(label) = rule["label"].as_str() {
            candidates.push(prospective(s, rules, &[label]));
        }
    }
    let modes: BTreeSet<_> = candidates.iter().map(|c| c.0.clone()).collect();
    let mode = if s["landing"]["command"]["kind"] == "hold" {
        "held".into()
    } else if let Some(mode) = s["landing"]["decision"]["mode"].as_str() {
        mode.into()
    } else if modes.len() == 1 {
        modes.first().unwrap().clone()
    } else {
        "policy pending".into()
    };
    let unique: BTreeSet<_> = candidates.iter().map(|c| c.1.to_string()).collect();
    let rule = if !recorded.is_null() {
        Some(recorded.clone())
    } else if unique.len() == 1 {
        Some(candidates.remove(0).1)
    } else {
        None
    };
    let text = match rule {
        None => "rule pending ticket labels".into(),
        Some(rule) => {
            if rule.get("default").is_some() {
                "default rule for integration builds: consent".into()
            } else {
                format!("rule {}: {}", number(&rule["index"]) + 1, rule["snapshot"])
            }
        }
    };
    (mode, text)
}
pub fn project(
    record: &Value,
    s: &Value,
    r: &Value,
    config: &Value,
    pipeline: &Value,
) -> (Value, Value) {
    let destination = if !s["target"].is_null() {
        s["target"]["ticket"]["id"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    } else {
        s["baseBranch"]
            .as_str()
            .unwrap_or("unknown destination")
            .into()
    };
    let o = &s["integration"]["observation"];
    let c = &s["integration"]["cycle"];
    let open = strings(&o["openChildren"]);
    let contributions = strings(&o["contributions"]);
    let complete = tree::integration_complete(s);
    let current = tree::integration_current(s);
    let verified = current && tree::cycle_verified(s);
    let ready = tree::ready(s, r);
    let selected: Value =
        serde_json::from_str(c["config"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
    let expected = strings(&selected["verify"]["steps"]);
    let receipts: Vec<_> = array(&s["verify"]["results"])
        .iter()
        .filter(|v| {
            current
                && number(&v["seq"]) > number(&c["seq"])
                && v["restackId"] == c["id"]
                && v["headSha"] == c["head"]
                && v["baseSha"] == c["parent"]
        })
        .collect();
    let failure = receipts
        .iter()
        .find(|v| v["outcome"] == "fail" && expected.iter().any(|name| v["step"] == *name));
    let passed: BTreeSet<_> = receipts
        .iter()
        .filter(|v| {
            (v["outcome"] == "pass" || v["outcome"] == "skipped")
                && expected.iter().any(|name| v["step"] == *name)
        })
        .map(|v| v["step"].as_str().unwrap_or_default())
        .collect();
    let (mode, rule) = policy(s, &config["landing"]);
    let conflict = if !s["nodeRestack"]["conflict"].is_null() {
        Some(&s["nodeRestack"]["conflict"])
    } else if !r["active"].is_null() && r["replay"]["conflicted"] == true {
        Some(&r["replay"])
    } else {
        None
    };
    let ticket = record["ticket"]["id"]
        .as_str()
        .or(record["slug"].as_str())
        .unwrap_or_default();
    let mut verify = step("verify", verified, current && !verified);
    if failure.is_some() {
        verify["qualifier"] = json!("failed");
    } else if current && !verified {
        verify["qualifier"] = json!(format!("{}/{}", passed.len(), expected.len()));
    }
    let mut land = step("merge", !s["integration"]["landing"].is_null(), ready);
    land["qualifier"] = json!(mode);
    let mut row = json!({"destination":destination,"parentDistance":distance(s),"openChildren":open,"verified":verified,"children":if !o.is_null() && array(&o["diagnostics"]).is_empty(){json!({"known":true,"landed":contributions.len(),"building":0,"queued":open.len(),"total":contributions.len()+open.len()})}else{json!({"known":false})},"steps":[step("spec",!s["specRev"].is_null(),false),step("open",!s["nodeOpened"].is_null(),s["nodeOpened"].is_null()),step("collect",complete,!s["nodeOpened"].is_null()&&!complete),verify,land]});
    if s["janitor"]["attention"] == true {
        row["alert"] = json!({"tone":"red","text":format!("Janitor failing: {}",s["janitor"]["message"].as_str().unwrap_or_default())});
    } else if conflict.is_some() {
        row["alert"] = json!({"tone":"red","text":format!("restack onto {destination} conflicted — open the detail view for files")});
    } else if let Some(failure) = failure {
        row["alert"] = json!({"tone":"red","text":format!("{} failed — file a repair child targeting {ticket}",failure["step"].as_str().unwrap_or_default())});
    } else if ready && mode == "consent" && s["landing"]["command"]["kind"] != "land" {
        row["alert"] = json!({"tone":"yellow","text":format!("ready to merge into {destination} — press l, or ab merge {}",record["slug"].as_str().unwrap_or_default())});
    }
    let source = o["membershipSource"]
        .as_str()
        .or(record["ticket"]["source"].as_str())
        .unwrap_or_default();
    let mut children = Vec::new();
    for child in array(&o["children"]) {
        let landed = array(&child["builds"])
            .iter()
            .any(|b| contributions.iter().any(|v| b == v));
        let is_open = child["source"] == source && open.iter().any(|v| child["id"] == *v);
        if array(&o["diagnostics"]).is_empty() && !is_open && !landed {
            continue;
        }
        let mut child = child.clone();
        if child["title"].is_null() {
            child["title"] = json!("title unavailable");
        }
        child["landed"] = json!(landed && !is_open);
        child["state"] = json!(if landed && !is_open {
            "merged"
        } else {
            "queued"
        });
        children.push(child);
    }
    for id in &open {
        if !children
            .iter()
            .any(|c| c["id"] == *id && c["source"] == source)
        {
            children.push(json!({"source":source,"id":id,"title":"title unavailable","state":"queued","landed":false}));
        }
    }
    for contribution in &contributions {
        if !children
            .iter()
            .any(|c| array(&c["builds"]).iter().any(|b| b == contribution))
        {
            children.push(json!({"source":source,"id":contribution,"builds":[contribution],"title":"title unavailable","state":"merged","landed":true}));
        }
    }
    children.sort_by(|a, b| {
        a["landed"]
            .as_bool()
            .cmp(&b["landed"].as_bool())
            .then(super::cells::compare(
                a["source"].as_str().unwrap_or_default(),
                b["source"].as_str().unwrap_or_default(),
            ))
            .then(super::cells::compare(
                a["id"].as_str().unwrap_or_default(),
                b["id"].as_str().unwrap_or_default(),
            ))
    });
    let steps = if c.is_null() {
        &pipeline["verify"]["steps"]
    } else {
        &selected["verify"]["steps"]
    };
    let mut seen = BTreeSet::new();
    let verify_steps:Vec<_>=array(steps).iter().filter(|name|seen.insert(name.to_string())).map(|name|{let failed=receipts.iter().find(|v|&v["step"]==name && v["outcome"]=="fail");let latest=receipts.iter().rev().find(|v|&v["step"]==name);json!({"step":name,"outcome":failed.or(latest).map(|v|v["outcome"].clone()).unwrap_or(json!("pending"))})}).collect();
    let failed = verify_steps.iter().find(|v| v["outcome"] == "fail");
    let verification = if let Some(f) = failed {
        format!(
            "{} failed — file a repair child targeting {ticket}",
            f["step"].as_str().unwrap_or_default()
        )
    } else if !complete {
        format!("pending — runs on the node head against {destination} once every child has merged")
    } else if verified {
        "verified on the current node head and destination".into()
    } else {
        "pending on the current node head and destination".into()
    };
    let mut detail = json!({"parentDistance":distance(s),"destination":format!("{destination}{}",if s["target"].is_null(){" (the configured base branch)"}else{""}),"branch":record["branch"].as_str().or(s["nodeOpening"]["branch"].as_str()).unwrap_or("unknown branch"),"restack":if conflict.is_some(){"conflicted"}else if !s["nodeRestack"]["active"].is_null() || !r["active"].is_null(){"active"}else{"idle"},"children":children,"membershipKnown":!o.is_null()&&array(&o["diagnostics"]).is_empty(),"diagnostics":o.get("diagnostics").cloned().unwrap_or(json!(["child membership unknown"])),"verification":verification,"verifySteps":verify_steps,"landing":format!("{mode} — {rule}{}",if ready && mode=="consent" && s["landing"]["command"]["kind"]!="land" {format!(" — press l, or ab merge {}",record["slug"].as_str().unwrap_or_default())}else{String::new()})});
    if let Some(conflict) = conflict {
        detail["conflictFiles"] = conflict
            .get("files")
            .cloned()
            .unwrap_or(json!(["conflicting filenames were not recorded"]));
    }
    if !s["nodeRestack"]["inventory"].is_null() {
        detail["handPushedCommits"] = json!(array(&s["nodeRestack"]["inventory"]["foreign"])
            .iter()
            .map(|sha| {
                let mut original = sha.clone();
                let mut visited = BTreeSet::new();
                while visited.insert(original.to_string()) {
                    if let Some(next) = s["nodeRestack"]["foreignAliases"]
                        .get(original.as_str().unwrap_or_default())
                    {
                        original = next.clone();
                    } else {
                        break;
                    }
                }
                json!({"sha":sha,"originalSha":original})
            })
            .collect::<Vec<_>>());
    }
    (row, detail)
}

/// Recompute collection text over already-read rows; no event replay or store reads.
pub fn enrich(rows: &mut [Value], records: &[Value]) {
    let source = rows.to_vec();
    for row in rows {
        if row["integrationRow"].is_null() || row["collectionIdentity"].is_null() {
            continue;
        }
        let identity = &row["collectionIdentity"];
        let live = |id: &Value, child_source: &Value, claims: &Value| -> Option<&Value> {
            source
                .iter()
                .filter(|child| {
                    let m = &child["collectionIdentity"];
                    !m.is_null()
                        && m["repo"] == identity["repo"]
                        && m["targetBuild"] == row["slug"]
                        && (array(claims).iter().any(|claim| claim == &child["slug"])
                            || (m["targetSource"] == identity["source"]
                                && m["targetId"] == identity["id"]
                                && (if m["id"].is_null() {
                                    &child["slug"] == id
                                } else {
                                    &m["source"] == child_source && &m["id"] == id
                                })))
                        && !["queued", "done", "aborted"]
                            .iter()
                            .any(|status| m["status"] == *status)
                })
                .max_by(|a, b| {
                    super::cells::compare(
                        a["collectionIdentity"]["createdAt"]
                            .as_str()
                            .unwrap_or_default(),
                        b["collectionIdentity"]["createdAt"]
                            .as_str()
                            .unwrap_or_default(),
                    )
                    .then(super::cells::compare(
                        a["slug"].as_str().unwrap_or_default(),
                        b["slug"].as_str().unwrap_or_default(),
                    ))
                })
        };
        let detail = &row["integrationDetail"];
        let building = array(&row["integrationRow"]["openChildren"])
            .iter()
            .filter(|id| {
                let child = array(&detail["children"])
                    .iter()
                    .find(|c| &c["id"] == *id && c["landed"] != true);
                let src = child
                    .and_then(|c| c.get("source"))
                    .unwrap_or(&identity["source"]);
                live(id, src, child.map(|c| &c["claims"]).unwrap_or(&Value::Null)).is_some()
            })
            .count();
        let mut children = Vec::<Value>::new();
        for child in array(&detail["children"]) {
            let active = if child["landed"] == true {
                None
            } else {
                live(&child["id"], &child["source"], &child["claims"])
            };
            let historical = records.iter().find(|r| {
                r["repo"] == identity["repo"]
                    && array(&child["builds"]).iter().any(|b| b == &r["slug"])
            });
            let mut next = child.clone();
            if let Some(record) = historical {
                if child["id"] == record["slug"] {
                    if let Some(id) = record["ticket"].get("id") {
                        next["id"] = id.clone();
                    }
                    if let Some(src) = record["ticket"].get("source") {
                        next["source"] = src.clone();
                    }
                }
            }
            if child["title"] == "title unavailable" {
                if let Some(title) = active
                    .and_then(|r| r["collectionIdentity"].get("title"))
                    .or_else(|| historical.and_then(|r| r["ticket"].get("title")))
                {
                    next["title"] = title.clone();
                }
            }
            next["state"] = if child["landed"] == true {
                json!("merged")
            } else {
                active
                    .and_then(|r| r["collectionIdentity"].get("phase"))
                    .cloned()
                    .unwrap_or(json!("queued"))
            };
            if let Some(previous) = children
                .iter_mut()
                .find(|p| p["source"] == next["source"] && p["id"] == next["id"])
            {
                let mut preferred = if previous["landed"] != true {
                    previous.clone()
                } else {
                    next.clone()
                };
                if preferred["title"] == "title unavailable" {
                    preferred["title"] = if previous["title"] != "title unavailable" {
                        previous["title"].clone()
                    } else {
                        next["title"].clone()
                    };
                }
                let builds: BTreeSet<_> = array(&previous["builds"])
                    .iter()
                    .chain(array(&next["builds"]))
                    .filter_map(Value::as_str)
                    .collect();
                preferred["builds"] = json!(builds);
                *previous = preferred;
            } else {
                children.push(next);
            }
        }
        children.sort_by(|a, b| {
            a["landed"]
                .as_bool()
                .cmp(&b["landed"].as_bool())
                .then(super::cells::compare(
                    a["source"].as_str().unwrap_or_default(),
                    b["source"].as_str().unwrap_or_default(),
                ))
                .then(super::cells::compare(
                    a["id"].as_str().unwrap_or_default(),
                    b["id"].as_str().unwrap_or_default(),
                ))
        });
        if !detail.is_null() {
            row["integrationDetail"]["children"] = json!(children);
        }
        if row["integrationRow"]["children"]["known"] == true {
            row["integrationRow"]["children"]["building"] = json!(building);
            row["integrationRow"]["children"]["queued"] =
                json!(array(&row["integrationRow"]["openChildren"])
                    .len()
                    .saturating_sub(building));
        }
    }
}
