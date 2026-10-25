//! TicketSource writes keep their own precedence and transaction boundaries.
//! Operator mutations have an additional validation/decorating layer and must
//! not silently acquire these transport semantics.
use super::*;

#[derive(Debug)]
pub enum MachineWriteError {
    Source(OperatorError),
    Revision {
        id: String,
        expected: String,
        current: String,
    },
}
impl From<OperatorError> for MachineWriteError {
    fn from(error: OperatorError) -> Self {
        Self::Source(error)
    }
}

fn requested_number(team: &str, requested: &str) -> Result<Option<i64>, OperatorError> {
    let Some(number) = requested.strip_prefix(&format!("{team}-")) else {
        return Ok(None);
    };
    if number.is_empty() || number.starts_with('0') || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(None);
    }
    number.parse().map(Some).map_err(|_| {
        refusal(format!(
            "ticket number exceeds PostgreSQL bigint: {requested}"
        ))
    })
}

impl TicketService<'_> {
    pub async fn machine_claim(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, OperatorError> {
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        seed(&tx, repo, policy).await?;
        let claimed = if let Some(row) = lookup(&tx, repo, id, false).await? {
            let storage_id: String = row.get("id");
            // PostgreSQL rechecks this predicate after waiting on a competing
            // updater. A stale read can never claim a done/already-claimed row.
            tx.execute("UPDATE ab_tickets SET state=$3,revision=revision+1,updated_at=$5 WHERE repo=$1 AND id=$2 AND state<>$3 AND state<>$4", &[&repo,&storage_id,&policy.doing,&policy.done,&now]).await.map_err(storage)? == 1
        } else {
            false
        };
        tx.commit().await.map_err(storage)?;
        Ok(claimed)
    }
    pub async fn machine_comment(
        &self,
        repo: &str,
        id: &str,
        body: &str,
        now: DateTime<Utc>,
    ) -> Result<(), OperatorError> {
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        let row = require(&tx, repo, id, "comment", true).await?;
        let storage_id: String = row.get("id");
        let seq: i64 = tx.query_one("SELECT COALESCE(MAX(seq),0) AS seq FROM ab_ticket_comments WHERE repo=$1 AND ticket_id=$2", &[&repo,&storage_id]).await.map_err(storage)?.get(0);
        tx.execute("INSERT INTO ab_ticket_comments (repo,ticket_id,seq,body,created_at) VALUES ($1,$2,$3,$4,$5)", &[&repo,&storage_id,&(seq+1),&body,&now]).await.map_err(storage)?;
        // Comments deliberately do not rewrite body or advance ticket revision.
        tx.commit().await.map_err(storage)?;
        Ok(())
    }
    pub async fn machine_create(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        draft: &Value,
        options: &Value,
        now: DateTime<Utc>,
    ) -> Result<Value, OperatorError> {
        let requested = options["requestedId"].as_str();
        if text(draft, "title")
            .trim_matches(crate::operator::auth::js_space)
            .is_empty()
        {
            return Err(refusal("database ticket create: title must be nonblank"));
        }
        if text(draft, "body")
            .trim_matches(crate::operator::auth::js_space)
            .is_empty()
            && requested.is_none()
        {
            return Err(refusal("database ticket create: body must be nonblank"));
        }
        if policy
            .team_key
            .trim_matches(crate::operator::auth::js_space)
            .is_empty()
        {
            return Err(refusal("ticket teamKey must be nonblank"));
        }
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        graph_lock(&tx, repo).await?;
        let key = options["idempotencyKey"].as_str();
        if let Some(key) = key {
            if let Some(row) = tx.query_opt("SELECT *,revision::text AS revision_text FROM ab_tickets WHERE repo=$1 AND creation_key=$2 FOR UPDATE", &[&repo,&key]).await.map_err(storage)? {
                let ticket=record(&tx,repo,policy,&row,false).await?;
                tx.commit().await.map_err(storage)?;
                return Ok(ticket);
            }
        }
        let target = tree(&tx, repo, None, draft).await?;
        let actual_state = state(
            &tx,
            repo,
            policy,
            options["state"].as_str().unwrap_or(&policy.create),
        )
        .await?;
        let mut blockers = Vec::new();
        for blocker in strings(&draft["blockedBy"]) {
            blockers.push(
                require(&tx, repo, &blocker, "create blocker", false)
                    .await?
                    .get::<_, String>("id"),
            );
        }
        let kept = requested
            .map(|id| requested_number(&policy.team_key, id))
            .transpose()?
            .flatten();
        let high:i64=tx.query_one("SELECT GREATEST((SELECT last_number FROM ab_ticket_counters WHERE repo=$1),COALESCE(MAX(ticket_number),0)) AS high FROM ab_tickets WHERE repo=$1",&[&repo]).await.map_err(storage)?.get(0);
        let number = match kept {
            Some(n) => n,
            None => high
                .checked_add(1)
                .ok_or_else(|| refusal("ticket numbers exhausted"))?,
        };
        if tx
            .query_opt(
                "SELECT id FROM ab_tickets WHERE repo=$1 AND ticket_number=$2",
                &[&repo, &number],
            )
            .await
            .map_err(storage)?
            .is_some()
        {
            return Err(refusal(format!(
                "requested ticket id already occupied: {}",
                requested.unwrap_or("undefined")
            )));
        }
        tx.execute(
            "UPDATE ab_ticket_counters SET last_number=$2 WHERE repo=$1",
            &[&repo, &number.max(high)],
        )
        .await
        .map_err(storage)?;
        let readable = format!("{}-{number}", policy.team_key);
        let id = uuid();
        let labels = strings(&draft["labels"]);
        let kind = draft["kind"].as_str().unwrap_or("work");
        let row=tx.query_one("INSERT INTO ab_tickets (repo,id,readable_id,ticket_number,creation_key,title,body,state,labels,created_at,updated_at,kind,target_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12) RETURNING *,revision::text AS revision_text",&[&repo,&id,&readable,&number,&key,&text(draft,"title"),&text(draft,"body"),&actual_state,&labels,&now,&kind,&target]).await.map_err(storage)?;
        for blocker in blockers.into_iter().collect::<BTreeSet<_>>() {
            tx.execute("INSERT INTO ab_ticket_blockers (repo,ticket_id,blocker_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",&[&repo,&id,&blocker]).await.map_err(storage)?;
        }
        let ticket = record(&tx, repo, policy, &row, false).await?;
        tx.commit().await.map_err(storage)?;
        Ok(ticket)
    }
    pub async fn machine_mutate(
        &self,
        repo: &str,
        policy: &TicketPolicy,
        id: &str,
        mutation: TicketMutation<'_>,
        expected: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), MachineWriteError> {
        if let TicketMutation::Update(patch) = &mutation {
            validate_patch(patch)?;
        }
        let mut connection = self.client().await?;
        let tx = connection.client.transaction().await.map_err(storage)?;
        if matches!(&mutation,TicketMutation::Update(p) if p.get("kind").is_some()||p.get("target").is_some())
        {
            graph_lock(&tx, repo).await?;
        }
        let next_state = match &mutation {
            TicketMutation::Move(name) => Some(state(&tx, repo, policy, name).await?),
            _ => None,
        };
        let row = require(&tx, repo, id, "mutation", true).await?;
        let storage_id: String = row.get("id");
        let current: String = row.get("revision_text");
        if let Some(expected) = expected {
            if expected != current {
                return Err(MachineWriteError::Revision {
                    id: id.into(),
                    expected: expected.into(),
                    current,
                });
            }
        }
        let mut changed = false;
        match mutation {
            TicketMutation::Update(patch) => {
                let target = tree(&tx, repo, Some(&row), patch).await?;
                let old_kind: String = row.get("kind");
                let kind = patch["kind"].as_str().unwrap_or(&old_kind);
                let old_title: String = row.get("title");
                let title = patch["title"].as_str().unwrap_or(&old_title);
                let old_body: String = row.get("body");
                let body = patch["body"].as_str().unwrap_or(&old_body);
                let old_labels: Vec<String> = row.get("labels");
                let labels = patch
                    .get("labels")
                    .map(strings)
                    .unwrap_or_else(|| old_labels.clone());
                changed = kind != old_kind
                    || target != row.get::<_, Option<String>>("target_id")
                    || title != old_title
                    || body != old_body
                    || label_set(&labels) != label_set(&old_labels);
                if changed {
                    tx.execute("UPDATE ab_tickets SET kind=$3,target_id=$4,title=$5,body=$6,labels=$7 WHERE repo=$1 AND id=$2",&[&repo,&storage_id,&kind,&target,&title,&body,&labels]).await.map_err(storage)?;
                }
            }
            TicketMutation::Move(_) => {
                let next = next_state.unwrap();
                changed = row.get::<_, String>("state") != next;
                if changed {
                    tx.execute(
                        "UPDATE ab_tickets SET state=$3 WHERE repo=$1 AND id=$2",
                        &[&repo, &storage_id, &next],
                    )
                    .await
                    .map_err(storage)?;
                }
            }
            TicketMutation::Block { ids, remove } => {
                let mut keys = BTreeSet::new();
                for blocker in ids {
                    let target = if !remove || expected.is_some() {
                        Some(require(&tx, repo, blocker, "blocker", false).await?)
                    } else {
                        lookup(&tx, repo, blocker, false).await?
                    };
                    if let Some(target) = target {
                        let key: String = target.get("id");
                        if !remove && key == storage_id {
                            return Err(
                                refusal(format!("ticket \"{id}\" cannot block itself")).into()
                            );
                        }
                        keys.insert(key);
                    }
                }
                for key in keys {
                    let count = if remove {
                        tx.execute("DELETE FROM ab_ticket_blockers WHERE repo=$1 AND ticket_id=$2 AND blocker_id=$3",&[&repo,&storage_id,&key]).await.map_err(storage)?
                    } else {
                        tx.execute("INSERT INTO ab_ticket_blockers (repo,ticket_id,blocker_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",&[&repo,&storage_id,&key]).await.map_err(storage)?
                    };
                    changed |= count > 0;
                }
            }
        }
        if changed {
            tx.execute(
                "UPDATE ab_tickets SET revision=revision+1,updated_at=$3 WHERE repo=$1 AND id=$2",
                &[&repo, &storage_id, &now],
            )
            .await
            .map_err(storage)?;
        }
        tx.commit().await.map_err(storage)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requested_ids_are_literal_canonical_positive_bounded_bigints() {
        assert_eq!(requested_number("A.+", "A.+-17").unwrap(), Some(17));
        for id in ["A.+-0", "A.+-01", "A.+--1", "A.+-1.0", "Other-1", "a.+-1"] {
            assert_eq!(requested_number("A.+", id).unwrap(), None);
        }
        assert_eq!(
            requested_number("A", "A-9223372036854775807").unwrap(),
            Some(i64::MAX)
        );
        assert_eq!(
            requested_number("A", "A-9223372036854775808")
                .unwrap_err()
                .error,
            "ticket number exceeds PostgreSQL bigint: A-9223372036854775808"
        );
    }
}
