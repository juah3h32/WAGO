apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: juah3h32av@berkeley.edu
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          ingress:
            class: traefik
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: wago-api
  namespace: default
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - api.wago.com
      secretName: wago-api-tls
  rules:
    - host: api.wago.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: wago-api
                port:
                  number: 3001
