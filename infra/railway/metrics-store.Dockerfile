# The metrics store on Railway. Attach a volume at /storage.
# -enableTCP6: Railway's private network can be IPv6-only, and the store listens on IPv4 alone without it.
FROM victoriametrics/victoria-metrics:v1.156.0
CMD ["-storageDataPath=/storage", "-retentionPeriod=30d", "-httpListenAddr=:8428", "-enableTCP6"]
