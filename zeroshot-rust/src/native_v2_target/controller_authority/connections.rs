use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionDeleteResult, ConnectionListRequest, ConnectionListResult,
    ConnectionMutationResult, ConnectionSetRequest,
};
use reqwest::header::{ACCEPT, CACHE_CONTROL};

use super::contract::{ConnectionsDescriptor, authority_error};
use super::TargetHttpControlAuthority;
use crate::native_v2_target::{TargetAccess, TargetAuthorityError, TargetRecord};

impl TargetHttpControlAuthority {
    async fn connection_access(
        &self,
        target: &TargetRecord,
    ) -> Result<(ConnectionsDescriptor, String), TargetAuthorityError> {
        if matches!(target.access, TargetAccess::Direct) {
            return Err(authority_error(
                "direct target does not advertise connection management",
            ));
        }
        let (auth, controller) = self.descriptors(target).await?;
        let routes = auth.connections.clone().ok_or_else(|| {
            authority_error("hosted target does not advertise connection management")
        })?;
        let access = self
            .access_token(target, &auth, &controller.audience)
            .await?;
        Ok((routes, access))
    }

    pub(super) async fn connection_list(
        &self,
        target: &TargetRecord,
        request: ConnectionListRequest,
    ) -> Result<ConnectionListResult, TargetAuthorityError> {
        let (routes, access) = self.connection_access(target).await?;
        let builder = self
            .authorized(self.client.post(routes.list.clone()), &access)?
            .header(ACCEPT, "application/json")
            .header(CACHE_CONTROL, "no-store")
            .json(&request);
        self.hosted_json(builder, &routes.list, "connection list")
            .await
    }

    pub(super) async fn connection_set(
        &self,
        target: &TargetRecord,
        request: ConnectionSetRequest,
    ) -> Result<ConnectionMutationResult, TargetAuthorityError> {
        let (routes, access) = self.connection_access(target).await?;
        let builder = self
            .authorized(self.client.post(routes.set.clone()), &access)?
            .header(ACCEPT, "application/json")
            .header(CACHE_CONTROL, "no-store")
            .json(&request);
        self.hosted_json(builder, &routes.set, "connection set")
            .await
    }

    pub(super) async fn connection_delete(
        &self,
        target: &TargetRecord,
        request: ConnectionDeleteRequest,
    ) -> Result<ConnectionDeleteResult, TargetAuthorityError> {
        let (routes, access) = self.connection_access(target).await?;
        let builder = self
            .authorized(self.client.post(routes.delete.clone()), &access)?
            .header(ACCEPT, "application/json")
            .header(CACHE_CONTROL, "no-store")
            .json(&request);
        self.hosted_json(builder, &routes.delete, "connection delete")
            .await
    }
}
