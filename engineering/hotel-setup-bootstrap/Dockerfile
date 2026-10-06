ARG PRIMARY_IMAGE
ARG ROLLBACK_IMAGE
FROM ${ROLLBACK_IMAGE} AS rollback
FROM ${PRIMARY_IMAGE}
COPY --from=rollback /app /proof/rollback
COPY engineering/hotel-setup-bootstrap-image-manifest.json /proof/image-manifest.json
# Only the protected operational task supplies the credential-bootstrap command.
CMD ["node", "-e", "process.stderr.write('Protected bootstrap command required\\n'); process.exit(1)"]
